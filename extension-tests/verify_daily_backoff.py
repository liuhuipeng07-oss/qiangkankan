"""低频策略：真实扩展请求节流、连续拒绝的退避、成功后保留拒绝历史和更新承接。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parents[1]
TARGET={'part_number':'MK2M4CH/A','url':'https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2m4ch/a','quantity':1,'price_cny':15999}
with sync_playwright() as p,tempfile.TemporaryDirectory(dir=ROOT) as temporary:
    context=p.chromium.launch_persistent_context(temporary,channel='msedge',headless=True,args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')],ignore_default_args=['--disable-extensions'])
    try:
        worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        panel=context.new_page();panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html');expect(panel.locator('#refresh')).to_be_enabled()
        worker.evaluate('''async target=>{await chrome.storage.local.set({targets:[target],settings:{mode:'monitor',strategy:'first_available',interval:10,postcode:'361000'},monitor:{running:false}});globalThis.fixtureStatus=541;globalThis.fixtureCount=0;globalThis.fetch=async url=>{fixtureCount++;const r=new Response(fixtureStatus===541?'blocked':JSON.stringify({body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'厦门模拟门店',partsAvailability:{'MK2M4CH/A':{pickupDisplay:'unavailable'}}}]}}),{status:fixtureStatus});Object.defineProperty(r,'url',{value:String(url)});return r}}''',TARGET)
        for strike,minutes,seconds in [(1,15,60),(2,30,120),(3,60,300)]:
            reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})');assert not reply['ok'] and '541' in reply['error'],reply
            data=worker.evaluate('async()=>await chrome.storage.local.get(["stockBlock","stockThrottle"])')
            assert data['stockThrottle']['strikes']==strike
            assert data['stockBlock']['until']-data['stockBlock']['at']==minutes*60000,data
            assert str(seconds)+' 秒' in data['stockBlock']['message']
            count=worker.evaluate('fixtureCount')
            panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"start"})')
            assert worker.evaluate('fixtureCount')==count
            panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"stop"})')
            # 等待结束后成功一次，拒绝历史仍保留，下一次拒绝需延长等待。
            worker.evaluate('''async()=>{fixtureStatus=200;const {monitor,stockBlock}=await chrome.storage.local.get(['monitor','stockBlock']);await chrome.storage.local.set({stockBlock:{...stockBlock,until:Date.now()-1},monitor:{...monitor,retryAt:0,lastStartedAt:0}})}''')
            reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})');assert reply['ok'],reply
            assert worker.evaluate('async()=>(await chrome.storage.local.get("stockThrottle")).stockThrottle.strikes')==strike
            # 查一次也不能绕过低频间隔。
            count=worker.evaluate('fixtureCount')
            reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
            assert reply['ok'] and reply['data']['throttled'] and worker.evaluate('fixtureCount')==count,reply
            worker.evaluate('''async()=>{fixtureStatus=541;const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({monitor:{...monitor,lastStartedAt:0,retryAt:0}})}''')
        # 旧版正在扫描 / 等待恢复的任务更新后改成 60 秒，保留运行及冷却。
        worker.evaluate('''async()=>{const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({settings:{mode:'rush',strategy:'first_available',interval:10,postcode:'361000',testOnly:false},monitor:{...monitor,running:true,lastStartedAt:Date.now(),retryAt:Date.now()+900000},stockBlock:{at:Date.now(),until:Date.now()+900000,status:541,message:'库存接口拒绝查询，等待恢复'}})}''')
        with context.expect_event('serviceworker',timeout=15000) as restarted:worker.evaluate('setTimeout(()=>chrome.runtime.reload(),100)')
        worker=restarted.value
        panel=context.new_page();panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html');expect(panel.locator('#interval')).to_have_value('60')
        data=worker.evaluate('async()=>await chrome.storage.local.get(["monitor","settings","stockBlock"])')
        assert data['monitor']['running'] and data['settings']['interval']==60 and data['stockBlock']['until']>data['stockBlock']['at']
        assert worker.evaluate('async()=>await chrome.alarms.get("iphone-pickup")')['periodInMinutes']==5
        print('PASS daily: 60 秒起步、541 等待15/30/60分钟、成功不清除拒绝历史、手动不绕过、更新保留扫描与冷却',flush=True)
    finally:context.close()
