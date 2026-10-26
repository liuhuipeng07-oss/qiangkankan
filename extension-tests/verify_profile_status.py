"""资料保存状态、持久回读、导入未保存、错误反馈及外部刷新不覆盖编辑。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p,tempfile.TemporaryDirectory(dir=ROOT) as temporary:
    context=p.chromium.launch_persistent_context(temporary,channel='msedge',headless=True,args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')],ignore_default_args=['--disable-extensions'])
    try:
        worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        url=worker.url.rsplit('/',1)[0]+'/panel.html'
        panel=context.new_page();panel.goto(url)
        expect(panel.locator('#profileStatusTitle')).to_have_text('尚未保存个人信息')
        for key,value in {'accountId':'fixture@example.invalid','lastName':'测试','firstName':'用户','phone':'13800000000','email':'fixture@example.invalid'}.items():panel.locator('[name="'+key+'"]').fill(value)
        expect(panel.locator('#profileStatusTitle')).to_have_text('有修改未保存')
        panel.locator('#saveProfile').click()
        expect(panel.locator('#profileStatusTitle')).to_have_text('已保存到本机')
        expect(panel.locator('#profileStatusDetail')).to_contain_text('最近保存')
        expect(panel.locator('#profileCompleteness')).to_contain_text('提货资料齐全')
        expect(panel.locator('#profileIndicator')).to_contain_text('已保存到本机')
        expect(panel.locator('#profileToastTitle')).to_have_text('保存成功 · 已存到本机')
        expect(panel.locator('#profileToast')).to_be_visible()
        panel.screenshot(path=str(ROOT/'profile-notice-preview.png'))
        panel.locator('#dismissProfileToast').click()
        expect(panel.locator('#profileToast')).to_be_hidden()
        panel.locator('section.profile').screenshot(path=str(ROOT/'profile-saved-preview.png'))
        assert worker.evaluate('async()=>(await chrome.storage.local.get("profileSavedAt")).profileSavedAt')>0
        panel.close();panel=context.new_page();panel.goto(url)
        expect(panel.locator('#profileStatusTitle')).to_have_text('已保存到本机')
        expect(panel.locator('[name="accountId"]')).to_have_value('fixture@example.invalid')
        panel.locator('[name="firstName"]').fill('未保存修改')
        worker.evaluate('async()=>await chrome.storage.local.set({results:{checkedAt:Date.now(),rows:[]}})')
        expect(panel.locator('[name="firstName"]')).to_have_value('未保存修改')
        expect(panel.locator('#profileStatusTitle')).to_have_text('有修改未保存')
        panel.locator('#envFile').set_input_files({'name':'.env','mimeType':'text/plain','buffer':b'APPLE_ID=imported@example.invalid\n'})
        expect(panel.locator('#profileStatusTitle')).to_have_text('有修改未保存')
        assert worker.evaluate('async()=>(await chrome.storage.local.get("profile")).profile.accountId')=='fixture@example.invalid'
        worker.evaluate('''()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async values=>{if('profile' in values)throw new Error('模拟存储失败');return original(values)}}''')
        panel.locator('#saveProfile').click()
        expect(panel.locator('#profileStatusTitle')).to_have_text('保存失败，修改尚未保存')
        expect(panel.locator('#profileStatusDetail')).to_contain_text('模拟存储失败')
        expect(panel.locator('#profileToastTitle')).to_contain_text('保存失败')
        expect(panel.locator('#profileToast')).to_be_visible()
        expect(panel.locator('[name="accountId"]')).to_have_value('imported@example.invalid')
        assert worker.evaluate('async()=>(await chrome.storage.local.get("profile")).profile.accountId')=='fixture@example.invalid'
        print('PASS profile: 未保存/已保存/有修改/失败四状态、保存时间、关闭重开回读、导入不误报保存、错误保留旧资料',flush=True)
    finally:context.close()
