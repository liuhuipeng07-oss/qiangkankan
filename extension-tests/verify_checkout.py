"""完整订单流程仅在拦截的本地页面上测试，不访问真实下单 / 付款端点。"""
import argparse
from pathlib import Path
import tempfile
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EXT = str(ROOT / 'extension')
TARGET = {'part_number': 'MK2M4CH/A', 'url': 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2m4ch/a', 'model': 'iPhone Duo', 'capacity': '256GB', 'color': '星光白色', 'quantity': 2, 'price_cny': 15999}
SETTINGS = {'mode': 'rush', 'strategy': 'first_available', 'interval': 30, 'postcode': '361000', 'storeId': 'R644', 'autofill': True, 'testOnly': False, 'payment': 'alipay', 'bank': '示例银行', 'periods': 24}
PROFILE = {'lastName': '测试', 'firstName': '用户', 'phone': '13800000000', 'email': 'fixture@example.invalid', 'idSuffix': '1234', 'accountId': 'fixture@example.invalid', 'province': '福建省', 'city': '厦门市', 'district': '思明区', 'line1': '本地模拟街道1号', 'line2': '', 'postcode': '361000'}
BASE = 'https://secure7.www.apple.com.cn/shop/checkout'

def wait_task(panel, stage):
    return panel.evaluate('''async stage=>{
      const until=Date.now()+30000;
      while(Date.now()<until){const {rushTask}=await chrome.storage.local.get('rushTask');if(rushTask?.stage===stage)return rushTask;await new Promise(resolve=>setTimeout(resolve,100));}
      throw new Error('Task did not reach '+stage);
    }''',stage)

def item(quantity, price=31998, extra=False, dropdown=False):
    quantity_html = '<select data-autom="item-quantity-dropdown" onchange="document.querySelector(\'[data-autom=bagtotalvalue]\').textContent=\'RMB \'+(15999*Number(this.value))"><option value="1">1</option><option value="2">2</option></select>' if dropdown else f'<span data-autom="bag-item-quantity">数量：{quantity}</span>'
    return f'''<div data-autom="bag-item-0"><a data-autom="bag-item-name" href="{TARGET['url']}">iPhone Duo 256GB 星光白色</a>{quantity_html}</div><div data-autom="bagtotalvalue">RMB {price}</div>''' + ('<div data-autom="bag-item-1"><h2>其他商品</h2></div>' if extra else '')

def fixture(path, case, loads):
    prefix = '<meta charset="utf-8">'
    if path == '/shop/bag':
        loads[0] += 1
        if case == 'extra': return prefix + item(2, extra=True)
        if loads[0] == 1: return prefix + '<h1>你的购物袋中没有商品。</h1>'
        if case == 'add_error': return prefix + '<title>Page Not Found - Apple</title><h1>The page you’re looking for can’t be found.</h1>'
        destination = 'SignIn' if case == 'login_resume' else 'Fulfillment'
        return prefix + item(1, price=15999, dropdown=True) + f'<button data-autom="checkout" onclick="location.href=\'{BASE}?_s={destination}\'">结账</button>'
    if path.startswith('/shop/buy-iphone/'):
        return prefix + '<button data-autom="add-to-cart" onclick="sessionStorage.setItem(\'adds\',String(Number(sessionStorage.getItem(\'adds\')||0)+1));location.href=\'/shop/bag\'">添加到购物袋</button>'
    return ''

def checkout_page(step, case):
    prefix = '<meta charset="utf-8">'
    if step == 'SignIn':
        return prefix + f'<h1>模拟本人完成登录</h1><button id="fixtureLogin" onclick="location.href=\'{BASE}?_s=Fulfillment-init\'">模拟登录完成</button>'
    if step in ['Fulfillment', 'Fulfillment-init']:
        if case in ['delivery', 'delivery_missing', 'delivery_off', 'delivery_timeout', 'delivery_dates', 'delivery_slots']:
            disabled = '' if case in ['delivery_dates', 'delivery_slots'] else ' disabled'
            dates = '<label><input type="radio" name="bartPickupDateSelectorButtonGroup" disabled value="2026-10-23">暂无可用日期</label>' if case == 'delivery_dates' else ''
            if case == 'delivery_slots': dates = '<label><input type="radio" name="bartPickupDateSelectorButtonGroup" value="2026-10-23">可选日期</label><select data-autom="pickup-availablewindow-dropdown"><option value="">暂无可用时段</option></select>'
            return prefix + f'''<button aria-checked="true">我要取货</button><button aria-checked="false" onclick="this.setAttribute('aria-checked','true');sessionStorage.setItem('deliveryClicks',String(Number(sessionStorage.getItem('deliveryClicks')||0)+1))">为我送货</button><label><input type="radio" name="store-locator-result" value="R644"{disabled}>厦门新生活广场</label>{dates}<button data-autom="fulfillment-continue-button" onclick="location.href='{BASE}?_s=ShippingAddress'">继续</button>'''
        html = prefix + '''<button aria-checked="false" onclick="this.setAttribute('aria-checked','true');fetch('/shop/checkoutx/fulfillment?_a=search')">我要取货</button><label><input type="radio" name="store-locator-result" value="R646">福州测试店</label><label><input type="radio" name="store-locator-result" value="R644">厦门新生活广场</label><label><input type="radio" name="bartPickupDateSelectorButtonGroup" value="2026-10-23">最早可选日期</label><select data-autom="pickup-availablewindow-dropdown"><option value="">请选择时段</option><option value="10:00-10:30">10:00–10:30</option></select>''' + f'<button data-autom="fulfillment-continue-button" onclick="location.href=\'{BASE}?_s=PickupContact\'">继续</button>'
        if case == 'transient': html = html.replace('value="R644"', 'value="R644" disabled') + '''<script>setTimeout(()=>document.querySelector('input[value="R644"]').disabled=false,2500)</script>'''
        return html
    if step == 'PickupContact':
        return prefix + '''<input data-autom="form-field-lastName" required><input data-autom="form-field-firstName" required><input data-autom="form-field-fullDaytimePhone" required><input data-autom="form-field-emailAddress" type="email" required><label>证件号码后四位<input data-autom="form-field-nationalIdSelf" maxlength="4" pattern="[0-9Xx]{4}" required></label>''' + f'<button data-autom="continue-button-label" onclick="location.href=\'{BASE}?_s=Billing\'">继续</button>'
    if step == 'ShippingAddress':
        fields = ''.join(f'<input data-autom="form-field-{name}" required>' for name in ['lastName', 'firstName', 'fullDaytimePhone', 'emailAddress', 'street', 'postalCode'])
        regions = ''.join(f'<select data-autom="form-field-{name}" required><option value="">请选择</option><option value="fixture">{text}</option></select>' for name, text in [('state','福建省'),('city','厦门市'),('district','思明区')])
        return prefix + fields + regions + f'<button data-autom="continue-button-label" onclick="location.href=\'{BASE}?_s=Billing\'">继续</button>'
    if step == 'Billing':
        available_period = 12 if case == 'fallback' else 24
        return prefix + f'''<label><input type="radio" name="payment" value="ALIPAY" data-autom="checkout-billingOptions-ALIPAY">支付宝</label><label><input type="radio" name="payment" value="installments-fixture" data-autom="checkout-billingOptions-INSTALLMENT" onclick="sessionStorage.setItem('bankClicks',String(Number(sessionStorage.getItem('bankClicks')||0)+1))">示例银行 0%费率 免息</label><label><input type="radio" name="period" value="{available_period}" data-autom="installments-fixture-{available_period}">{available_period}期</label><button data-autom="continue-button-review" onclick="location.href='{BASE}?_s=Review'">查看订单</button>'''
    if step == 'Review':
        final = item(2, price=40000 if case == 'price' else 31998)
        final += '' if case == 'review_unknown' else '<section data-autom="review-fulfillment">送货上门</section>' if case == 'review_delivery' else '<section data-autom="review-fulfillment">在 Apple 厦门新生活广场取货，2026-10-23 10:00-10:30</section>'
        navigation = '' if case in ['timeout', 'delivery_timeout'] else f"location.href='{BASE}?_s=Confirmation';"
        disabled = ' disabled' if case == 'stop' else ''
        return prefix + final + f'''<button data-autom="continue-button-placeOrder"{disabled} onclick="sessionStorage.setItem('submits',String(Number(sessionStorage.getItem('submits')||0)+1));{navigation}">立即下单</button>'''
    if step == 'Confirmation':
        return prefix + '<h1>订单已生成，待付款</h1><p>订单号：<span data-autom="order-number">W1234567890</span></p>'
    return prefix + '<h1>未知测试步骤</h1>'

def run(playwright, case):
    with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
        context = playwright.chromium.launch_persistent_context(temporary, channel='msedge', headless=True, args=['--disable-extensions-except=' + EXT, '--load-extension=' + EXT], ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            panel = context.new_page(); panel.goto(worker.url.rsplit('/', 1)[0] + '/panel.html')
            expect(panel.locator('#refresh')).to_be_enabled(timeout=10000)
            settings = {**SETTINGS, 'payment': 'installment_or_alipay' if case in ['installment', 'fallback'] else 'alipay'}
            settings.update(interval=3, fallbackDelivery=case != 'delivery_off')
            if case == 'test_only': settings['testOnly']=True
            worker.evaluate('''async data=>{
              await chrome.storage.local.set(data);
              globalThis.fixtureNotifications=[];
              chrome.notifications.create=async(id,options)=>{fixtureNotifications.push({id,...options});return id;};
              globalThis.fetch=async()=>{
                const response=new Response(JSON.stringify({body:{stores:[{city:'厦门',storeNumber:'R644',storeName:'厦门新生活广场',partsAvailability:{'MK2M4CH/A':{pickupDisplay:'available',storePickEligible:true,pickupSearchQuote:'本地模拟库存'}}}]}}),{status:200});
                Object.defineProperty(response,'url',{value:'https://www.apple.com.cn/shop/retail/pickup-message'});return response;
              };
            }''', {'targets': [TARGET], 'settings': settings, 'profile': {**PROFILE, 'line1': ''} if case == 'delivery_missing' else PROFILE, 'profileRevision': 0})
            loads = [0]
            def route(request):
                parsed = urlsplit(request.request.url)
                if parsed.path == '/shop/checkout':
                    html = checkout_page(parse_qs(parsed.query).get('_s', [''])[0], case)
                else:
                    html = fixture(parsed.path, case, loads)
                request.fulfill(body=html or '<h1>本地模拟</h1>', status=541 if case=='add_error' and parsed.path=='/shop/bag' and loads[0]>1 else 200, content_type='text/html; charset=utf-8')
            context.route('https://www.apple.com.cn/**', route)
            context.route('https://secure7.www.apple.com.cn/**', route)
            panel.reload()
            errors = []; panel.on('pageerror', lambda e: errors.append(str(e)))
            expect(panel.locator('#start')).to_be_enabled(timeout=10000)
            panel.locator('#start').click()
            expect(panel.locator('#notice')).to_contain_text('已启动', timeout=10000)
            if case == 'login_resume':
                expect(panel.locator('#taskText')).to_contain_text('官网要求登录',timeout=20000)
                checkout=next(page for page in context.pages if '_s=SignIn' in page.url)
                checkout.locator('#fixtureLogin').click()
                expect(checkout.get_by_role('button',name='我要取货',exact=True)).to_have_attribute('aria-checked','true',timeout=10000)
            if case in ['alipay', 'installment', 'fallback', 'transient', 'login_resume', 'radar']:
                expect(panel.locator('#taskText')).to_contain_text('已生成', timeout=35000)
                task = panel.evaluate('async()=> (await chrome.storage.local.get("rushTask")).rushTask')
                assert task['stage'] == 'ordered'
                assert task['orderNumber'] == 'W1234567890'
                assert task['bagProof']['quantity'] == 2 and task['reviewProof']['quantity'] == 2
                if case.startswith('delivery'):
                    assert task['fulfillmentMode'] == 'delivery' and task['addressVerified'] and task['deliveryConfirmed']
                    assert task['pickup'] is None
                else:
                    assert task['pickup']['storeId'] == 'R644' and task['pickup']['slot'] == '10:00-10:30'
                assert task['payment']['method'] == ('INSTALLMENT' if case == 'installment' else 'ALIPAY')
                confirmation = next(p for p in context.pages if '_s=Confirmation' in p.url)
                assert confirmation.evaluate('sessionStorage.getItem("submits")') == '1'
                if case == 'radar':
                    expect(panel.locator('#paymentAlert')).to_be_visible()
                    reminders = worker.evaluate('fixtureNotifications.filter(n=>n.id.startsWith("order-"))')
                    assert reminders[-1]['requireInteraction'] and reminders[-1]['priority']==2
                    assert worker.evaluate('async()=>await chrome.alarms.get("iphone-payment-reminder")')['periodInMinutes']==1
                    count = len(context.pages); panel.locator('#openPayment').click(); panel.wait_for_timeout(300)
                    assert len(context.pages)==count
                    # 真实 alarm 事件验证周期提醒；无需真的等待一分钟。
                    worker.evaluate('''async()=>{const {paymentReminder}=await chrome.storage.local.get('paymentReminder');await chrome.storage.local.set({paymentReminder:{...paymentReminder,lastNotifiedAt:1}});await chrome.alarms.create('iphone-payment-reminder',{when:Date.now()+300})}''')
                    assert worker.evaluate('''expected=>new Promise(resolve=>{const until=Date.now()+5000;const poll=()=>{const count=fixtureNotifications.filter(n=>n.id.startsWith('order-')).length;if(count>=expected||Date.now()>until)resolve(count);else setTimeout(poll,50)};poll()})''',len(reminders)+1)==len(reminders)+1
                    panel.locator('#acknowledgePayment').click();expect(panel.locator('#paymentAlert')).to_be_hidden()
                    assert not worker.evaluate('async()=>await chrome.alarms.get("iphone-payment-reminder")')
                    assert worker.evaluate('async()=>(await chrome.storage.local.get("paymentReminder")).paymentReminder.acknowledged')
                if case.startswith('delivery'): assert confirmation.evaluate('sessionStorage.getItem("deliveryClicks")') == '1'
                assert loads[0] == 2, '切换配送应复用购物袋，不再加入商品'
                if case in ['installment', 'fallback']: assert confirmation.evaluate('sessionStorage.getItem("bankClicks")') == '1'
                reply = panel.evaluate('async()=> await chrome.runtime.sendMessage({type:"start"})')
                assert not reply['ok'] and '提交记录' in reply['error']
                assert confirmation.evaluate('sessionStorage.getItem("submits")') == '1'
            elif case in ['extra', 'price', 'add_error', 'test_only', 'review_delivery', 'review_unknown']:
                # “金额 / 购物袋”也会出现在处理中提示；等待实际暂停状态，避免过早判定。
                wait_task(panel,'manual')
                expect(panel.locator('#taskText')).to_contain_text('订单复核页未能确认' if case.startswith('review_') else '测试已到订单复核页' if case == 'test_only' else '官网加袋返回' if case == 'add_error' else '购物袋' if case == 'extra' else '金额', timeout=30000)
                task = panel.evaluate('async()=> (await chrome.storage.local.get("rushTask")).rushTask')
                assert task['stage'] == 'manual'
                attempts = panel.evaluate('async()=> (await chrome.storage.local.get("orderAttempts")).orderAttempts||{}')
                assert not attempts
                if case == 'add_error':
                    assert task['resumeStage']=='bag' and loads[0]==2
                    expect(panel.locator('#taskText')).to_contain_text('541')
                    panel.wait_for_timeout(1500)
                    assert loads[0]==2
                if case == 'test_only':
                    assert task['pickup']['storeId']=='R644' and task['pickup']['slot']=='10:00-10:30' and task['contactVerified']
                    review=next(page for page in context.pages if '_s=Review' in page.url)
                    assert review.evaluate('sessionStorage.getItem("submits")') is None
                    reply=panel.evaluate('async()=>await chrome.runtime.sendMessage({type:"resumeStep"})')
                    assert not reply['ok'] and '测试' in reply['error']
            elif case in ['delivery', 'delivery_dates', 'delivery_slots', 'delivery_missing', 'delivery_off', 'delivery_timeout']:
                wait_task(panel,'waiting_stock')
                task = panel.evaluate('async()=> (await chrome.storage.local.get("rushTask")).rushTask')
                assert '不会切换配送' in task['note'],task
                assert task['stage']=='waiting_stock' and task['fulfillmentMode']=='pickup' and not task['fallbackDelivery']
                assert all('_s=ShippingAddress' not in p.url for p in context.pages)
                assert worker.evaluate('async()=>(await chrome.storage.local.get("monitor")).monitor.running')
                assert not panel.evaluate('async()=> (await chrome.storage.local.get("orderAttempts")).orderAttempts||{}')
            elif case in ['timeout', 'delivery_timeout']:
                expect(panel.locator('#taskText')).to_contain_text('等待官网订单号', timeout=35000)
                worker.evaluate('''async()=>{const {rushTask}=await chrome.storage.local.get('rushTask');await chrome.storage.local.set({rushTask:{...rushTask,submittedAt:Date.now()-100000}})}''')
                expect(panel.locator('#taskText')).to_contain_text('未确认订单号', timeout=10000)
                review = next(p for p in context.pages if '_s=Review' in p.url)
                assert review.evaluate('sessionStorage.getItem("submits")') == '1'
                reply = panel.evaluate('async()=> await chrome.runtime.sendMessage({type:"start"})')
                assert not reply['ok'] and '提交记录' in reply['error']
                review.wait_for_timeout(1500)
                assert review.evaluate('sessionStorage.getItem("submits")') == '1'
            elif case == 'stop':
                expect(panel.locator('#taskText')).to_contain_text('正在复核订单', timeout=35000)
                panel.locator('#stop').click()
                expect(panel.locator('#running')).to_have_text('未启动')
                review = next(p for p in context.pages if '_s=Review' in p.url)
                review.locator('[data-autom="continue-button-placeOrder"]').evaluate('e=>e.disabled=false')
                review.wait_for_timeout(2000)
                assert review.evaluate('sessionStorage.getItem("submits")') is None
            assert not errors, errors
            print('PASS checkout:', case, flush=True)
        finally:
            context.close()

parser = argparse.ArgumentParser(); parser.add_argument('--cases', nargs='+', default=['alipay','installment','fallback','extra','price','timeout','stop','delivery','delivery_dates','delivery_slots','transient','add_error','login_resume','test_only','review_delivery','review_unknown','radar']); args = parser.parse_args()
with sync_playwright() as playwright:
    for case in args.cases: run(playwright, case)
