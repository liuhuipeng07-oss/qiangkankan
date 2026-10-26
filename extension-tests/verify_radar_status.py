"""顶部雷达显示进度、库存、冷却、结算和付款；只使用模拟本机存储。"""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with sync_playwright() as p, tempfile.TemporaryDirectory(dir=ROOT) as tmp:
    ctx = p.chromium.launch_persistent_context(tmp,channel='msedge',headless=True,args=['--disable-extensions-except='+str(ROOT/'extension'),'--load-extension='+str(ROOT/'extension')],ignore_default_args=['--disable-extensions'])
    try:
        worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        panel=ctx.new_page(); panel.goto(worker.url.rsplit('/',1)[0]+'/panel.html')
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('雷达待命')
        assert panel.locator('#profileIndicator').count()==0
        def update(values):
            worker.evaluate('async values=>await chrome.storage.local.set(values)',values)
        now=worker.evaluate('Date.now()')
        update({'settings':{'mode':'monitor','interval':300},'monitor':{'running':True,'scans':12,'lastStartedAt':now},'results':{'checkedAt':now,'rows':[{'part_number':'TEST','state':'unavailable','stores':[]}]}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('暂未发现厦门自提库存')
        expect(panel.locator('#radarIndicatorDetail')).to_contain_text('12 轮已完成')
        expect(panel.locator('#radarIndicatorDetail')).to_contain_text('秒后可再扫描')
        update({'results':{'checkedAt':now,'rows':[{'state':'available'}]}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('厦门自提有货 · 1 个配置')
        panel.screenshot(path=str(ROOT/'radar-stock-preview.png'))
        update({'results':{'checkedAt':now,'stale':True,'rows':[{'state':'available'}]},'stockBlock':{'until':now+900000}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('库存未知 · 查询暂不可用')
        expect(panel.locator('#radarIndicatorDetail')).to_contain_text('等待至')
        update({'rushTask':{'stage':'manual','note':'请完成登录验证'}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('锁单暂停，需要你处理')
        expect(panel.locator('#radarIndicator')).to_have_attribute('href','#task')
        update({'rushTask':{'stage':'fulfillment','note':'正在选择取货时段'}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('发现自提有货，正在锁单')
        update({'paymentReminder':{'acknowledged':False,'orderNumber':'W123456789','label':'测试商品','quantity':1}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('订单已生成，请付款')
        expect(panel.locator('#radarIndicator')).to_have_attribute('href','#paymentAlert')
        update({'paymentReminder':None,'monitor':{'running':False},'rushTask':{'stage':'uncertain','note':'先核实订单'}})
        expect(panel.locator('#radarIndicatorTitle')).to_have_text('订单结果待核实')
        print('PASS radar status: countdown, out of stock, in stock, stale cooldown, manual, checkout, payment and uncertain')
    finally:
        ctx.close()
