"""维护错误、持久退避、恢复和购买页暂停。所有官网响应都在隔离会话模拟。"""
from pathlib import Path
import argparse
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TARGET = {'part_number':'MJYM4CH/A','url':'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjym4ch/a','quantity':1,'price_cny':21499}
parser = argparse.ArgumentParser(); parser.add_argument('--case', default='all'); args = parser.parse_args()
with sync_playwright() as p, tempfile.TemporaryDirectory(dir=ROOT) as temporary:
    context = p.chromium.launch_persistent_context(temporary, channel='msedge', headless=True, args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')], ignore_default_args=['--disable-extensions'])
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        panel = context.new_page(); panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html')
        expect(panel.locator('#refresh')).to_be_enabled()
        worker.evaluate('''async target=>{
          await chrome.storage.local.set({targets:[target],settings:{mode:'rush',interval:1,postcode:'361000',testOnly:true}});
          globalThis.fixtureStatus=503;globalThis.fixtureRequests=0;
          globalThis.fetch=async url=>{fixtureRequests++;const r=new Response(fixtureStatus===503?'<title>The Apple Store</title>':JSON.stringify({body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'模拟门店',partsAvailability:{'MJYM4CH/A':{pickupDisplay:'unavailable',storePickEligible:false}}}]}}),{status:fixtureStatus,headers:{'Retry-After':'120'}});Object.defineProperty(r,'url',{value:String(url)});return r;};
        }''',TARGET)
        if args.case in ['all','inventory']:
            reply = panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
            assert not reply['ok'] and '维护' in reply['error'], reply
            hold = worker.evaluate('async()=>(await chrome.storage.local.get("stockBlock")).stockBlock')
            assert hold and hold['until']-hold['at'] >= 120000, hold
            count = worker.evaluate('fixtureRequests')
            reply = panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"start"})')
            assert reply['ok'] and reply['data']['blocked'], reply
            panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
            assert worker.evaluate('fixtureRequests') == count
            assert not worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
            worker.evaluate('''async()=>{fixtureStatus=200;const {stockBlock,monitor}=await chrome.storage.local.get(['stockBlock','monitor']);await chrome.storage.local.set({stockBlock:{...stockBlock,until:Date.now()-1},monitor:{...monitor,lastStartedAt:0,retryAt:0}})}''')
            reply = panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
            assert reply['ok'], reply
            assert not worker.evaluate('async()=>(await chrome.storage.local.get("stockBlock")).stockBlock')
            print('PASS maintenance inventory: 明确维护提示、遵守 Retry-After、重启及查一次不绕过、成功恢复',flush=True)
        if args.case in ['all','page']:
            context.route('https://www.apple.com.cn/**', lambda r:r.fulfill(status=503,body='<meta charset="utf-8"><title>The Apple Store</title><button data-autom="add-to-cart" onclick="window.fixtureClicks=(window.fixtureClicks||0)+1">添加</button>',content_type='text/html'))
            page = context.new_page(); page.goto(TARGET['url'])
            tabid = worker.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',TARGET['url'])
            for stage in ['preflight','product','adding','checkout','review']:
                worker.evaluate('''async data=>await chrome.storage.local.set({monitor:{running:true},rushTask:{id:'maintenance',tabId:data.tabid,target:data.target,stage:data.stage,changedAt:Date.now(),startedAt:Date.now(),testOnly:true}})''',{'target':TARGET,'tabid':tabid,'stage':stage})
                panel.wait_for_function('async()=>(await chrome.storage.local.get("rushTask")).rushTask?.stage==="manual"',timeout=5000)
                expect(panel.locator('#taskText')).to_contain_text('维护',timeout=5000)
                task = worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
                assert task['stage']=='manual' and task['resumeStage']==('bag' if stage=='adding' else stage),task
                assert page.evaluate('window.fixtureClicks||0')==0
            assert not worker.evaluate('async()=>(await chrome.storage.local.get("orderAttempts")).orderAttempts')
            # 提交后遇到维护不能退回可重试步骤，仍然保留防重复记录。
            worker.evaluate('''async()=>{const {rushTask}=await chrome.storage.local.get('rushTask');await chrome.storage.local.set({rushTask:{...rushTask,stage:'submitting',submittedAt:Date.now()-130000},orderAttempts:{[rushTask.target.part_number]:{state:'submitting'}}})}''')
            reply = panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"check",manual:true})')
            assert reply['ok'] and reply['data']['uncertain'], reply
            task = worker.evaluate('async()=>(await chrome.storage.local.get("rushTask")).rushTask')
            assert task['stage']=='uncertain'
            assert page.evaluate('window.fixtureClicks||0')==0
            reply = panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"resumeStep"})')
            assert not reply['ok']
            print('PASS maintenance page: HTTP 503 暂停各购买步骤，不加袋、不提交',flush=True)
    finally:
        context.close()
