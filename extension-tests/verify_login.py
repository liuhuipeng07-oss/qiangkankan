"""快捷登录模拟测试：账号填写、浏览器已填密码、验证码保持人工、限定目标标签页。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EXT = str(ROOT / 'extension')
AUTH = 'https://idmsa.apple.com.cn/appleauth/auth/test-fixture'
with tempfile.TemporaryDirectory(dir=ROOT) as temporary, sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(temporary, channel='msedge', headless=True, args=['--disable-extensions-except=' + EXT, '--load-extension=' + EXT], ignore_default_args=['--disable-extensions'])
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        panel = context.new_page(); panel.goto(worker.url.rsplit('/', 1)[0] + '/panel.html')
        expect(panel.locator('#refresh')).to_be_enabled()
        worker.evaluate('async()=>await chrome.storage.local.set({profile:{accountId:"fixture@example.invalid"}})')
        host = '<meta charset="utf-8"><iframe src="' + AUTH + '" style="width:500px;height:400px"></iframe>'
        auth = '''<meta charset="utf-8"><input id="account_name_text_field"><input id="password_text_field" type="password" style="display:none"><input id="verification-code"><button id="sign-in" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#password_text_field').style.display='block';if(window.clicks>1){this.disabled=true;document.querySelector('#otp-prompt').hidden=false}">继续</button><p id="otp-prompt" hidden>请本人输入验证码</p>'''
        context.route('https://www.apple.com.cn/shop/account/home', lambda r: r.fulfill(body=host, content_type='text/html; charset=utf-8'))
        context.route(AUTH, lambda r: r.fulfill(body=auth, content_type='text/html; charset=utf-8'))
        with context.expect_page() as opened:
            panel.locator('#login').click()
        login = opened.value
        login.wait_for_url('https://www.apple.com.cn/shop/account/home', timeout=10000)
        frame = login.frame_locator('iframe')
        expect(frame.locator('#account_name_text_field')).to_have_value('fixture@example.invalid', timeout=10000)
        expect(frame.locator('#password_text_field')).to_be_visible(timeout=10000)
        expect(frame.locator('#password_text_field')).to_have_value('')
        frame.locator('#password_text_field').fill('fixture-only-password')
        expect(frame.locator('#otp-prompt')).to_be_visible(timeout=10000)
        expect(frame.locator('#verification-code')).to_have_value('')
        auth_frame = next(f for f in login.frames if f.url == AUTH)
        assert auth_frame.evaluate('window.clicks') == 2
        stored = worker.evaluate('async()=>await chrome.storage.local.get("profile")')
        assert 'password' not in stored['profile'] and 'APPLE_PASSWORD' not in stored['profile']
        other = context.new_page(); other.goto('https://www.apple.com.cn/shop/account/home')
        other.wait_for_timeout(2000)
        expect(other.frame_locator('iframe').locator('#account_name_text_field')).to_have_value('')
        # 当前结账中的登录框无需另点快捷登录；快捷登录也不能把结账切到账号主页。
        checkout_url = 'https://secure11.www.apple.com.cn/shop/checkout?_s=Fulfillment-init'
        context.route(checkout_url, lambda r: r.fulfill(body=host, content_type='text/html; charset=utf-8'))
        checkout = context.new_page(); checkout.goto(checkout_url)
        tabid = worker.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id', checkout_url)
        worker.evaluate('''async tabId=>await chrome.storage.local.set({monitor:{running:true},rushTask:{id:'login-fixture',tabId,stage:'manual',resumeStage:'checkout',pauseReason:'login',note:'官网要求登录 / 验证'}})''', tabid)
        expect(checkout.frame_locator('iframe').locator('#account_name_text_field')).to_have_value('fixture@example.invalid', timeout=10000)
        page_count = len(context.pages)
        panel.locator('#login').click()
        expect(panel.locator('#notice')).to_contain_text('当前结账页', timeout=10000)
        assert len(context.pages) == page_count and checkout.url == checkout_url
        expect(checkout.frame_locator('iframe').locator('#verification-code')).to_have_value('')
        print('PASS: 快捷登录填写账号、使用浏览器已有密码、验证码本人完成、密码不保存、非指定标签页不自动登录')
    finally:
        context.close()
