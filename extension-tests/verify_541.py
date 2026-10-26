"""真实扩展错误路径：541 冷却、防重新启动刷接口、旧库存失效与恢复。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TARGET = {'part_number':'MK2M4CH/A','url':'https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2m4ch/a','quantity':1,'price_cny':15999}
with sync_playwright() as p, tempfile.TemporaryDirectory(dir=ROOT) as temporary:
    extension=str(ROOT/'extension')
    context=p.chromium.launch_persistent_context(temporary,channel='msedge',headless=True,args=['--disable-extensions-except='+extension,'--load-extension='+extension],ignore_default_args=['--disable-extensions'])
    try:
        worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        panel=context.new_page(); panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html')
        expect(panel.locator('#refresh')).to_be_enabled(timeout=10000)
        worker.evaluate('''async target=>{
          await chrome.storage.local.set({targets:[target],settings:{mode:'monitor',strategy:'first_available',interval:1,postcode:'361000',autofill:true,payment:'alipay',periods:24}});
          globalThis.statusCode=200;globalThis.requests=[];
          chrome.notifications.create=async()=> 'fixture';
          globalThis.fetch=async url=>{
            requests.push(String(url));
            const data={body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'模拟门店',partsAvailability:{'MK2M4CH/A':{pickupDisplay:'available',storePickEligible:true}}}]}};
            const r=new Response(statusCode===200?JSON.stringify(data):'<title>Page Not Found - Apple</title>',{status:statusCode});
            Object.defineProperty(r,'url',{value:String(url)});return r;
          };
        }''',TARGET)
        panel.reload();expect(panel.locator('#check')).to_be_enabled()
        panel.locator('#check').click();expect(panel.locator('#targets .stock')).to_contain_text('有货')
        worker.evaluate('''async()=>{statusCode=541;const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({monitor:{...monitor,lastStartedAt:0}})}''')
        panel.locator('#check').click();expect(panel.locator('#notice')).to_contain_text('541')
        hold=worker.evaluate('async()=> (await chrome.storage.local.get("stockBlock")).stockBlock')
        assert hold and hold['until']-hold['at']>=900000, 'BUG: 541 未设置独立的 15 分钟冷却，停止 / 重启可继续刷接口'
        expect(panel.locator('#targets .stock')).to_contain_text('状态未知')
        expect(panel.locator('#lastCheck')).to_contain_text('暂停')
        assert len(worker.evaluate('requests'))==2
        # 查一次、启动、停止后再启动，以及面板重载都不能重置冷却。
        panel.locator('#check').click();expect(panel.locator('#notice')).to_contain_text('冷却')
        panel.locator('#start').click();expect(panel.locator('#running')).to_have_text('冷却中')
        assert worker.evaluate('async()=> await chrome.action.getBadgeText({})')=='冷却'
        panel.wait_for_timeout(1300)
        panel.locator('#stop').click();panel.locator('#start').click()
        expect(panel.locator('#running')).to_have_text('冷却中')
        panel.reload();expect(panel.locator('#lastCheck')).to_contain_text('暂停')
        assert len(worker.evaluate('requests'))==2
        assert not worker.evaluate('async()=> (await chrome.storage.local.get("rushTask")).rushTask')
        # 检查官网按钮仅打开 / 复用商品页面，不触发购物袋或解除冷却。
        context.route('https://www.apple.com.cn/**',lambda r:r.fulfill(body='<meta charset="utf-8"><h1>模拟官网检查页面</h1>',content_type='text/html; charset=utf-8'))
        panel.locator('#inspectWebsite').click()
        panel.wait_for_timeout(700)
        shop=[page for page in context.pages if page.url.startswith('https://www.apple.com.cn/shop/buy-iphone/')]
        assert len(shop)==1 and len(worker.evaluate('requests'))==2
        panel.locator('#inspectWebsite').click();panel.wait_for_timeout(300)
        assert len([page for page in context.pages if page.url.startswith('https://www.apple.com.cn/shop/buy-iphone/')])==1
        # 模拟冷却到期，只在新请求成功后清除拦截记录并恢复有效库存。
        worker.evaluate('''async()=>{statusCode=200;const {stockBlock,monitor}=await chrome.storage.local.get(['stockBlock','monitor']);await chrome.storage.local.set({stockBlock:{...stockBlock,until:Date.now()-1},monitor:{...monitor,lastStartedAt:0,retryAt:0}})}''')
        reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
        assert reply['ok'],reply
        expect(panel.locator('#targets .stock')).to_contain_text('有货')
        assert not worker.evaluate('async()=> (await chrome.storage.local.get("stockBlock")).stockBlock')
        panel.locator('#stop').click()
        assert all('pl=true' in u and 'mts.0=regular' in u for u in worker.evaluate('requests'))
        # 从旧版已失败状态重新加载：升级承接冷却，不立即再请求官网。
        worker.evaluate('''async()=>{const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({stockBlock:null,monitor:{...monitor,running:false,error:'官网请求失败（HTTP 541），请打开官网检查登录或验证提示',lastStartedAt:Date.now()}})}''')
        with context.expect_event('serviceworker',timeout=15000) as restarted:
            worker.evaluate('setTimeout(()=>chrome.runtime.reload(),100)')
        worker=restarted.value
        panel=context.new_page()
        panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html')
        expect(panel.locator('#lastCheck')).to_contain_text('暂停',timeout=10000)
        migrated=worker.evaluate('async()=> (await chrome.storage.local.get("stockBlock")).stockBlock')
        assert migrated['until']-migrated['at']==900000
        print('PASS 541: 独立冷却、重启不刷接口、库存未知、官网检查、成功恢复与旧版升级',flush=True)
    finally:
        context.close()
