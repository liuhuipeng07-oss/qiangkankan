"""隔离浏览器验证启动门槛、节流、后台超时及通知失败；无真实购买请求。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TARGET = {'part_number':'MJYN4CH/A','url':'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyn4ch/a','quantity':1,'price_cny':21499}
PROFILE = {'lastName':'测试','firstName':'用户','phone':'13800000000','email':'fixture@example.invalid'}
with sync_playwright() as p, tempfile.TemporaryDirectory(dir=ROOT) as tmp:
    ctx = p.chromium.launch_persistent_context(tmp,channel='msedge',headless=True,args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')],ignore_default_args=['--disable-extensions'])
    try:
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        panel = ctx.new_page(); panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html'); expect(panel.locator('#refresh')).to_be_enabled()
        worker.evaluate('''async target=>{
          await chrome.storage.local.set({targets:[target],settings:{mode:'rush',strategy:'first_available',interval:300,postcode:'361000',autofill:true,testOnly:false}});
          globalThis.calls=0;globalThis.notices=[];globalThis.noticeFail=false;
          chrome.notifications.getPermissionLevel=async()=> 'granted';
          chrome.notifications.create=async(id,o)=>{if(noticeFail)throw new Error('fixture');notices.push({id,...o});return id};
          globalThis.fetch=async url=>{calls++;const r=new Response(JSON.stringify({body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'测试门店',partsAvailability:{'MJYN4CH/A':{pickupDisplay:'unavailable'}}}]}}));Object.defineProperty(r,'url',{value:String(url)});return r};
        }''',TARGET)
        send = lambda msg: panel.evaluate('async m=>await chrome.runtime.sendMessage(m)',msg)
        reply=send({'type':'start'}); assert not reply['ok'] and '提货资料' in reply['error']
        assert worker.evaluate('calls')==0
        worker.evaluate('async profile=>await chrome.storage.local.set({profile})',PROFILE)
        panel.reload(); expect(panel.locator('#interval')).to_have_value('300')
        panel.locator('#radar').click(); expect(panel.locator('#notice')).to_contain_text('已启动库存雷达')
        assert worker.evaluate('async()=>(await chrome.storage.local.get("settings")).settings.interval')==300
        assert worker.evaluate('calls')==1
        assert send({'type':'stop'})['ok'] and send({'type':'start'})['ok']
        assert worker.evaluate('calls')==1
        assert send({'type':'check','manual':True})['data']['throttled']
        assert worker.evaluate('async()=>!!await chrome.alarms.get("iphone-checkout-watchdog")')
        # 后台真实 alarm 在无内容脚本帮助时检测卡住，不刷新或提交。
        worker.evaluate('''async target=>{await chrome.storage.local.set({rushTask:{id:'stuck',target,stage:'fulfillment',changedAt:Date.now()-600000}});await chrome.alarms.create('iphone-checkout-watchdog',{when:Date.now()+100})}''',TARGET)
        expect(panel.locator('#taskText')).to_contain_text('超过 2 分钟')
        task=worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
        assert task['stage']=='manual' and task['resumeStage']=='fulfillment'
        assert worker.evaluate('notices.length')==1 and worker.evaluate('calls')==1
        send({'type':'check'}); assert worker.evaluate('notices.length')==1
        # 提交阶段超时只能进入结果不明，保留防重复记录。
        worker.evaluate('''async()=>{const {rushTask}=await chrome.storage.local.get('rushTask');await chrome.storage.local.set({rushTask:{...rushTask,stage:'submitting',submittedAt:Date.now()-600000}})}''')
        send({'type':'check'})
        data=worker.evaluate('async()=>await chrome.storage.local.get(["rushTask","monitor","orderAttempts"])')
        assert data['rushTask']['stage']=='uncertain' and not data['monitor']['running']
        assert data['orderAttempts'][TARGET['part_number']]['state']=='uncertain'
        assert not send({'type':'start'})['ok']
        # 明确显示通知失败，然后测试恢复；不制造订单提醒记录。
        worker.evaluate('noticeFail=true'); panel.locator('#testNotification').click()
        expect(panel.locator('#notificationStatus')).to_contain_text('发送失败')
        worker.evaluate('noticeFail=false'); panel.locator('#testNotification').click()
        expect(panel.locator('#notificationStatus')).to_contain_text('已交给系统通知')
        assert not worker.evaluate('async()=>(await chrome.storage.local.get("paymentReminder")).paymentReminder')
        panel.screenshot(path=str(ROOT/'radar-reliability-preview.png'),full_page=True)
        print('PASS reliability: profile gate, preserved interval, restart throttle, real watchdog alarm, uncertain no retry, notification failure/recovery')
    finally:
        ctx.close()
