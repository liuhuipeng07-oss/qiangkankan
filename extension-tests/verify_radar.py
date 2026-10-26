"""雷达快捷启动、多 SKU 扫描、锁单期间不刷库存、售罄退回扫描及标签页复用。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
TARGETS=[{'part_number':part,'url':'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/'+part.lower(),'quantity':1,'price_cny':21499,'model':'iPhone 18 Pro Max','capacity':'2TB','color':'测试色'} for part in ['MJYN4CH/A','MJYM4CH/A']]
with sync_playwright() as p,tempfile.TemporaryDirectory(dir=ROOT) as temporary:
    context=p.chromium.launch_persistent_context(temporary,channel='msedge',headless=True,args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')],ignore_default_args=['--disable-extensions'])
    try:
        worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        panel=context.new_page();panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html');expect(panel.locator('#refresh')).to_be_enabled()
        context.route('https://www.apple.com.cn/**',lambda r:r.fulfill(body='<meta charset="utf-8"><h1>本地测试等待页</h1>',content_type='text/html'))
        worker.evaluate('''async targets=>{
          await chrome.storage.local.set({targets,profile:{lastName:'测试',firstName:'用户',phone:'13800000000',email:'fixture@example.invalid'}});globalThis.fixtureAvailable=[];globalThis.fixtureRequests=[];
          chrome.notifications.create=async()=> 'fixture';
          globalThis.fetch=async url=>{fixtureRequests.push(String(url));const parts=Object.fromEntries(targets.map(t=>[t.part_number,{pickupDisplay:fixtureAvailable.includes(t.part_number)?'available':'unavailable',storePickEligible:true}]));const r=new Response(JSON.stringify({body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'厦门新生活广场',partsAvailability:parts}]}}),{status:200});Object.defineProperty(r,'url',{value:String(url)});return r};
        }''',TARGETS)
        panel.reload();expect(panel.locator('#radar')).to_be_enabled();panel.locator('#radar').click();expect(panel.locator('#notice')).to_contain_text('已启动库存雷达')
        data=worker.evaluate('async()=>await chrome.storage.local.get(["settings","monitor"])')
        assert data['settings']['mode']=='rush' and not data['settings']['testOnly'] and not data['settings']['fallbackDelivery']
        assert data['settings']['interval']==60 and data['settings']['strategy']=='first_available' and data['monitor']['scans']==1
        assert 'parts.0=MJYN4CH%2FA' in worker.evaluate('fixtureRequests[0]') and 'parts.1=MJYM4CH%2FA' in worker.evaluate('fixtureRequests[0]')
        count=len(context.pages)
        worker.evaluate('''async()=>{fixtureAvailable=['MJYM4CH/A'];const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({monitor:{...monitor,lastStartedAt:0}})}''')
        reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check"})');assert reply['ok'],reply
        task=worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
        assert task['target']['part_number']=='MJYM4CH/A' and not task['fallbackDelivery'] and not task['testOnly']
        assert len(context.pages)==count+1
        requests=len(worker.evaluate('fixtureRequests'))
        reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
        assert reply['data']['checkout'] and len(worker.evaluate('fixtureRequests'))==requests
        worker.evaluate('''async()=>{const {monitor,rushTask}=await chrome.storage.local.get(['monitor','rushTask']);await chrome.storage.local.set({rushTask:{...rushTask,stage:'waiting_stock'},monitor:{...monitor,lastStartedAt:0,stockRetryAt:{[rushTask.target.part_number]:Date.now()+60000}}})}''')
        panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check"})')
        assert len(context.pages)==count+1 and worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask.stage')=='waiting_stock'
        worker.evaluate('''async()=>{const {monitor}=await chrome.storage.local.get('monitor');await chrome.storage.local.set({monitor:{...monitor,lastStartedAt:0,stockRetryAt:{}}})}''')
        panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check"})')
        next_task=worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
        assert next_task['id']!=task['id'] and next_task['tabId']==task['tabId'] and len(context.pages)==count+1
        panel.locator('#stop').click();expect(panel.locator('#running')).to_have_text('未启动')
        assert not worker.evaluate('async()=>(await chrome.storage.local.get("orderAttempts")).orderAttempts')
        print('PASS radar: 60 秒正式自提锁单预设、多 SKU 优先级、锁单暂停扫描、售罄冷却重扫、复用购买标签页',flush=True)
    finally:context.close()
