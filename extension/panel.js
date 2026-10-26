import {validateTargets, validateSettings, effectiveScanInterval, cleanProfile} from './core.js';
const $ = id => document.getElementById(id);
let state = {}, products = [], familyCache = new Map(), polling = false;
const profileKeys = ['lastName', 'firstName', 'phone', 'email', 'province', 'city', 'district', 'line1', 'line2', 'postcode', 'accountId', 'idSuffix'];
let profileReady = false, profileDirty = false, profileSaving = false, profileSaveError = '', savedFormSignature = '';
let profileToastTimer;
function hideProfileToast() { clearTimeout(profileToastTimer); $('profileToast').hidden = true; }
function showProfileToast() {
  clearTimeout(profileToastTimer);
  const error = Boolean(profileSaveError);
  $('profileToast').className = 'profile-toast ' + (error ? 'error' : 'saved');
  $('profileToastIcon').textContent = error ? '!' : '✓';
  $('profileToastTitle').textContent = error ? '保存失败 · 本次修改未保存' : profileDirty ? '已保存，但还有新修改未保存' : '保存成功 · 已存到本机';
  $('profileToastDetail').textContent = error ? profileSaveError + '，请检查后重试。' : '已回读确认，下次打开插件仍可读取。';
  $('profileToast').hidden = false;
  if (!error) profileToastTimer = setTimeout(hideProfileToast, 8000);
}
const profileFormValues = () => Object.fromEntries(profileKeys.map(key => [key, $('profileForm').elements.namedItem(key).value]));
const profileSignature = () => JSON.stringify(profileKeys.map(key => $('profileForm').elements.namedItem(key).value.trim()));
function loadSavedProfile() {
  for (const key of profileKeys) $('profileForm').elements.namedItem(key).value = state.profile?.[key] || '';
  savedFormSignature = profileSignature(); profileDirty = false;
}
function renderProfileStatus() {
  const profile = state.profile || {}, saved = profileKeys.some(key => Boolean(profile[key]));
  const tone = profileSaveError ? 'error' : profileDirty ? 'dirty' : saved ? 'saved' : 'empty';
  $('profileStatus').className = 'profile-status ' + tone;
  $('profileStatusTitle').textContent = profileSaving ? '正在保存到本机…' : profileSaveError ? '保存失败，修改尚未保存' : profileDirty ? '有修改未保存' : saved ? '已保存到本机' : '尚未保存个人信息';
  $('profileStatusDetail').textContent = profileSaveError || (profileDirty ? '当前修改只在表单中，请点击下方“保存到本机”。' : saved ? state.profileSavedAt ? '最近保存：' + new Date(state.profileSavedAt).toLocaleString('zh-CN') + '；重新打开插件仍可读取。' : '已从本机存储读取资料；此前保存时间未记录。' : '填写后请点击“保存到本机”，仅输入或导入表单不会保存。');
  const labels = {lastName:'姓',firstName:'名',phone:'电话',email:'联系邮箱'};
  const missing = Object.keys(labels).filter(key => !profile[key]).map(key => labels[key]);
  $('profileCompleteness').textContent = `已保存资料：Apple 账号${profile.accountId ? '已填' : '未填'}；提货资料${missing.length ? '还缺：' + missing.join('、') : '齐全'}。`;
  $('saveProfile').disabled = profileSaving;
  $('saveProfile').textContent = profileSaving ? '保存中…' : profileDirty ? '保存修改到本机' : '保存到本机';
  $('profileSaveHint').textContent = profileSaving ? '正在写入并回读确认' : profileDirty || profileSaveError ? '尚未保存' : saved ? '已确认保存' : '请先保存资料';
}
const defaults = {mode: 'monitor', strategy: 'first_available', interval: 60, postcode: '361000', storeId: '', autofill: true, fallbackDelivery: false, testOnly: true, payment: 'installment_or_alipay', bank: '', periods: 24};

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({type, ...payload});
  if (!response?.ok) throw new Error(response?.error || '插件后台未响应，请重载插件');
  return response.data;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function options(element, entries, placeholder = '') {
  element.replaceChildren();
  if (placeholder) element.add(new Option(placeholder, ''));
  for (const [value, label] of entries) element.add(new Option(label, value));
  element.disabled = !entries.length;
}
function familyName(slug) {
  return slug.replace(/^iphone-/, 'iPhone ').split(' ').map((word, i) => i ? word.split('-').map(v => /^\d/.test(v) ? v : v[0].toUpperCase() + v.slice(1)).join(' ') : word).join(' ');
}
function parseCatalog(html, family) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let raw;
  try { raw = JSON.parse(doc.querySelector('#metrics')?.textContent || '').data.products; }
  catch { throw new Error('官网未返回可解析的 SKU，不能使用猜测的配置'); }
  if (!Array.isArray(raw)) throw new Error('官网 SKU 格式发生变化');
  const links = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      const url = new URL(a.getAttribute('href'), 'https://www.apple.com.cn');
      const part = url.pathname.match(/\/([a-z0-9]+\/[a-z])$/i)?.[1].toUpperCase();
      if (part && url.origin === 'https://www.apple.com.cn' && url.pathname.startsWith('/shop/buy-iphone/')) links.set(part, {url: url.href, color: a.querySelector('.dimensionColor')?.textContent.trim()});
    } catch { /* 忽略非商品链接 */ }
  }
  const found = new Map();
  const header = doc.querySelector('#as-noscript-header')?.cloneNode(true);
  if (header) for (const e of header.querySelectorAll('h1,.badge')) e.remove();
  const headerText = header?.textContent.replace(/\s+/g, ' ').trim() || '';
  const sale_notice = /预购|发售|批准/.test(headerText) ? headerText.slice(0, 250) : '';
  for (const p of raw) {
    const name = String(p.name || '').replace(/\s+/g, ' ').trim();
    const match = name.match(/\b\d+\s*(GB|TB)\b/i);
    const part = String(p.partNumber || '').toUpperCase();
    const link = links.get(part);
    if (p.category !== 'iphone' || !match || !link) continue;
    found.set(part, {family, part_number: part, model: name.slice(0, match.index).trim(), capacity: match[0].replace(/\s/g, '').toUpperCase(), color: link.color || name.slice(match.index + match[0].length).trim(), price_cny: p.price?.fullPrice, url: link.url, sale_notice});
  }
  if (!found.size) throw new Error('未找到带有官网商品链接的 SKU');
  return [...found.values()];
}
function capacitySize(text) { return parseInt(text) * (text.includes('TB') ? 1024 : 1); }
async function refreshFamilies() {
  $('refresh').disabled = true;
  try {
    notice('正在读取 Apple 中国官网型号……');
    const {html} = await send('page', {path: '/shop/buy-iphone'});
    const doc = new DOMParser().parseFromString(html, 'text/html'), families = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.getAttribute('href'), 'https://www.apple.com.cn');
        if (u.origin === 'https://www.apple.com.cn' && /^\/shop\/buy-iphone\/iphone-[a-z0-9-]+$/.test(u.pathname)) {
          const slug = u.pathname.split('/').pop(); families.set(slug, familyName(slug));
        }
      } catch { /* 无效链接 */ }
    }
    if (!families.size) throw new Error('未读取到官网型号，请打开官网检查网络或网站验证');
    familyCache.clear();
    options($('family'), [...families], '请选择系列');
    options($('model'), []); options($('capacity'), []); options($('color'), []);
    $('add').disabled = true;
    notice(`已读取 ${families.size} 个系列，选择一个读取具体 SKU。`);
  } finally { $('refresh').disabled = false; }
}
async function loadFamily() {
  const family = $('family').value;
  products = []; $('add').disabled = true;
  if (!family) { options($('model'), []); options($('capacity'), []); options($('color'), []); return; }
  notice('正在读取该系列的官网 SKU……');
  if (!familyCache.has(family)) {
    const {html} = await send('page', {path: '/shop/buy-iphone/' + family});
    familyCache.set(family, parseCatalog(html, family));
  }
  // 用户快速切换系列时，丢弃先前请求的结果。
  if ($('family').value !== family) return;
  products = familyCache.get(family);
  const merged = [...familyCache.values()].flat();
  await send('saveCatalog', {catalog: merged});
  options($('model'), [...new Set(products.map(p => p.model))].map(v => [v, v]));
  updateCapacity();
  $('catalogTime').textContent = `本次从官网读取 ${products.length} 个 SKU · ${new Date().toLocaleString('zh-CN')}`;
  notice('官网配置已读取，选择容量、颜色和数量后添加目标。');
}
function updateCapacity() {
  const capacities = [...new Set(products.filter(p => p.model === $('model').value).map(p => p.capacity))].sort((a, b) => capacitySize(a) - capacitySize(b));
  options($('capacity'), capacities.map(v => [v, v])); updateColor();
}
function updateColor() {
  const items = products.filter(p => p.model === $('model').value && p.capacity === $('capacity').value);
  options($('color'), items.map(p => [p.part_number, p.color])); updateSKU();
}
function updateSKU() {
  const p = products.find(p => p.part_number === $('color').value);
  $('price').textContent = p ? '¥ ' + Number(p.price_cny).toLocaleString('zh-CN') : '—';
  $('sku').textContent = p?.part_number || '尚未选择 SKU'; $('add').disabled = !p;
  $('saleNotice').hidden = !p?.sale_notice;
  $('saleNotice').textContent = p?.sale_notice ? '官网预购提示（读取时）：' + p.sale_notice : '';
}
function readSettings() {
  return validateSettings({mode: document.querySelector('input[name=mode]:checked').value, strategy: $('strategy').value, interval: Number($('interval').value), postcode: $('postcode').value, storeId: $('store').value, autofill: $('autofill').checked, fallbackDelivery: $('fallbackDelivery').checked, testOnly: $('testOnly').checked, payment: $('payment').value, bank: $('bank').value, periods: Number($('periods').value)});
}
function restoreSettings() {
  const s = validateSettings({...defaults, ...state.settings});
  document.querySelector(`input[name=mode][value="${s.mode === 'rush' ? 'rush' : 'monitor'}"]`).checked = true;
  $('strategy').value = s.strategy; $('interval').value = String(s.interval); $('postcode').value = s.postcode; $('autofill').checked = s.autofill;
  $('payment').value = s.payment; $('bank').value = s.bank; $('periods').value = String(s.periods);
  $('fallbackDelivery').checked = false;
  $('testOnly').checked = s.testOnly;
  if (s.storeId && !$('store').querySelector(`option[value="${s.storeId.replace(/[^a-zA-Z0-9]/g, '')}"]`)) $('store').add(new Option('所选门店 ' + s.storeId, s.storeId));
  $('store').value = s.storeId;
}
function renderRadar() {
  const monitor = state.monitor || {}, task = state.rushTask;
  const payment = state.paymentReminder && !state.paymentReminder.acknowledged;
  let text = '雷达待命';
  if (payment) text = '已确认订单，正在提醒付款';
  else if (monitor.running) {
    if (task?.stage === 'manual') text = '等待你处理当前购买步骤，扫描已暂停';
    else if (task && !['stopped', 'ordered', 'waiting_stock'].includes(task.stage)) text = '正在核对并锁单，扫描已暂停';
    else if (state.stockBlock?.until > Date.now() || monitor.retryAt > Date.now()) text = '官网退避中，等待恢复扫描';
    else {
      const interval = effectiveScanInterval(state.settings, state.stockThrottle);
      const seconds = Math.max(0, Math.ceil(((monitor.lastStartedAt || 0) + interval * 1000 - Date.now()) / 1000));
      text = `${state.targets?.length || 0} 个 SKU · 每轮至少 ${interval} 秒 · 已完成 ${monitor.scans || 0} 轮 · ${seconds ? seconds + ' 秒后可再扫描' : '正在等待下一轮'}`;
    }
  }
  $('radarSummary').textContent = text;
  const rows = state.results?.rows || [];
  const retryAt = Math.max(state.stockBlock?.until || 0, monitor.retryAt || 0);
  const stale = state.results?.stale || retryAt > Date.now();
  const available = stale ? [] : rows.filter(row => row.state === 'available');
  const interval = effectiveScanInterval(state.settings, state.stockThrottle);
  const remaining = Math.max(0, Math.ceil(((monitor.lastStartedAt || 0) + interval * 1000 - Date.now()) / 1000));
  const checked = state.results?.checkedAt ? '最近成功查询 ' + new Date(state.results.checkedAt).toLocaleTimeString('zh-CN') : '尚未完成库存查询';
  let title = monitor.running ? '正在扫描厦门自提库存' : '雷达待命';
  let detail = monitor.running ? `${monitor.scans || 0} 轮已完成 · ${state.targets?.length || 0} 个 SKU · ${remaining ? remaining + ' 秒后可再扫描' : '等待下一轮查询'}` : '选择商品并启动雷达，等待厦门自提有货';
  let tone = monitor.running ? 'scanning' : 'idle', icon = monitor.running ? '◉' : '○', anchor = '#targets';
  if (payment) {
    title = '订单已生成，请付款'; detail = '已取得官网订单号 · 点击查看付款提醒'; tone = 'available'; icon = '✓'; anchor = '#paymentAlert';
  } else if (task?.stage === 'uncertain') {
    title = '订单结果待核实'; detail = task.note; tone = 'warning'; icon = '!'; anchor = '#task';
  } else if (monitor.running && task?.stage === 'manual') {
    title = '锁单暂停，需要你处理'; detail = task.note; tone = 'warning'; icon = '!'; anchor = '#task';
  } else if (monitor.running && task && !['stopped', 'ordered', 'waiting_stock'].includes(task.stage)) {
    title = '发现自提有货，正在锁单'; detail = task.note; tone = 'available'; icon = '◉'; anchor = '#task';
  } else if (stale || monitor.error) {
    title = '库存未知 · 查询暂不可用'; detail = retryAt > Date.now() ? `等待至 ${new Date(retryAt).toLocaleTimeString('zh-CN')} 再查询 · ${checked}` : `${monitor.error || '上次库存结果已失效'} · ${checked}`; tone = 'warning'; icon = '!';
  } else if (available.length) {
    title = `厦门自提有货 · ${available.length} 个配置`; detail = checked + ' · 库存以结账页为准'; tone = 'available'; icon = '✓';
  } else if (rows.length) {
    title = rows.some(row => row.state === 'unknown') ? '部分库存未知' : '暂未发现厦门自提库存';
    if (!monitor.running) detail = '扫描已停止 · ' + checked;
    if (rows.some(row => row.state === 'unknown')) { tone = 'warning'; icon = '!'; }
  }
  $('radarIndicator').className = 'radar-indicator ' + tone;
  $('radarIndicator').href = anchor;
  $('radarIndicatorTitle').textContent = title;
  $('radarIndicatorDetail').textContent = detail;
  $('radarIndicatorIcon').textContent = icon;
}
function render() {
  renderProfileStatus();
  $('notificationStatus').textContent = state.notificationStatus ? state.notificationStatus.message : '尚未测试桌面提醒。浏览器关闭或电脑休眠时无法扫描；目前不含手机推送。';
  $('notificationStatus').className = state.notificationStatus?.ok === false ? 'boundary' : 'muted';
  $('targets').replaceChildren();
  const rows = state.results?.rows || [], targets = state.targets || [];
  $('empty').hidden = targets.length > 0;
  for (const [index, target] of targets.entries()) {
    const tr = document.createElement('tr');
    const config = document.createElement('td');
    const name = document.createElement('div'); name.textContent = `${index + 1}. ${target.model} ${target.capacity} ${target.color}`;
    const code = document.createElement('small'); code.textContent = target.part_number; config.append(name, code);
    const quantity = document.createElement('td'); quantity.textContent = String(target.quantity);
    const inventory = document.createElement('td');
    const result = rows.find(r => r.part_number === target.part_number), stock = document.createElement('span');
    const stockState = state.results?.stale || state.stockBlock?.until > Date.now() ? 'unknown' : result?.state;
    stock.className = 'stock ' + (stockState || ''); stock.textContent = ({available: '有货 · 数量待确认', unavailable: '暂不可自提', unknown: '状态未知'})[stockState] || '待查询';
    inventory.append(stock);
    if (result) {
      const quote = document.createElement('small'); quote.textContent = (state.results?.stale ? '上次成功查询（已失效）：' : '') + result.stores.map(s => `${s.name}：${s.quote}`).join('；'); inventory.append(quote);
      for (const s of result.stores) if (![...$('store').options].some(o => o.value === s.id)) $('store').add(new Option(s.name, s.id));
    }
    const action = document.createElement('td'), remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = '移除';
    remove.addEventListener('click', async () => {
      try {
        const next = targets.filter(t => t.part_number !== target.part_number);
        if (next.length) await send('saveTargets', {targets: next});
        else { await send('stop'); await chrome.storage.local.set({targets: [], results: null, rushTask: null}); }
        await refreshState(); notice('目标已更新，监控已停止，请重新启动。');
      } catch (error) { notice(error.message, true); }
    });
    action.append(remove); tr.append(config, quantity, inventory, action); $('targets').append(tr);
  }
  const running = Boolean(state.monitor?.running);
  const cooling = state.stockBlock?.until > Date.now();
  $('running').textContent = running ? cooling ? '冷却中' : '运行中' : '未启动'; $('running').classList.toggle('live', running && !cooling);
  $('start').disabled = !targets.length || running;
  $('radar').disabled = !targets.length || running || Boolean(state.paymentReminder && !state.paymentReminder.acknowledged);
  $('stop').disabled = !running;
  $('check').disabled = !targets.length;
  $('lastCheck').textContent = cooling ? `${state.stockBlock.message} · ${running ? '最早自动重试' : '可再次查询'}：${new Date(state.stockBlock.until).toLocaleTimeString('zh-CN')}` : state.monitor?.error ? `${state.monitor.error} · ${running ? '自动重试时间' : '可再次查询'} ${new Date(state.monitor.retryAt).toLocaleTimeString('zh-CN')}` : state.results?.checkedAt ? '最近查询：' + new Date(state.results.checkedAt).toLocaleString('zh-CN') : '尚未查询';
  const task = state.rushTask; $('task').hidden = !task;
  const reminder = state.paymentReminder;
  $('paymentAlert').hidden = !reminder || reminder.acknowledged;
  if (reminder) $('paymentText').textContent = `${reminder.label} × ${reminder.quantity} · 订单 ${reminder.orderNumber}。请到官网完成支付宝 / 分期付款。`;
  renderRadar();
  if (task) {
    $('taskText').textContent = task.note;
    $('resume').disabled = !['manual', 'stopped', 'ordered'].includes(task.stage);
    $('continueStep').hidden = task.stage !== 'manual' || !task.resumeStage || !running || task.testOnly !== false && task.resumeStage === 'review';
  }
  const attempts = Object.entries(state.orderAttempts || {});
  $('attempts').hidden = !attempts.length; $('attempts').replaceChildren();
  for (const [part, attempt] of attempts) {
    const text = document.createElement('p'); text.textContent = `${part} × ${attempt.quantity} · ${attempt.state === 'ordered' ? '已生成订单 ' + attempt.orderNumber : '提交结果需核实'} · 防重复提交已启用`;
    const clear = document.createElement('button'); clear.className = 'ghost'; clear.textContent = '原订单已取消，解除此 SKU 防重复'; clear.disabled = running;
    clear.addEventListener('click', async () => {
      if (!confirm('请先在官网确认原订单不存在或已取消。解除后可再次提交该 SKU，确认原订单已核实？')) return;
      try { await send('releaseAttempt', {part}); await refreshState(); notice('已解除此 SKU 本地防重复记录，官网订单未修改。'); } catch (error) { notice(error.message, true); }
    });
    $('attempts').append(text, clear);
  }
}
async function refreshState() {
  const next = await send('state');
  const changed = JSON.stringify(state.profile) !== JSON.stringify(next.profile);
  state = next;
  if (profileReady && !profileDirty && changed) loadSavedProfile();
  render();
}
function bind(id, action) { $(id).addEventListener('click', () => action().catch(error => notice(error.message, true))); }
bind('refresh', refreshFamilies);
bind('inspectWebsite', async () => { await send('inspectWebsite'); notice('已打开官网商品页。请检查页面是否有验证或登录提示；库存查询冷却不会被重置。'); });
$('family').addEventListener('change', () => loadFamily().catch(error => notice(error.message, true)));
$('model').addEventListener('change', updateCapacity); $('capacity').addEventListener('change', updateColor); $('color').addEventListener('change', updateSKU);
bind('login', async () => { const result = await send('quickLogin'); notice((result.reusedCheckout ? '已回到当前结账页登录。' : '已打开快捷登录。') + (result.accountSaved ? '自动填写保存的账号；浏览器已填密码时会继续。' : '尚未保存 Apple 账号，请先在本机资料中保存，或在官网填写。') + '验证码和设备确认由你完成，结账任务登录后自动继续。'); });
bind('orders', () => chrome.tabs.create({url: 'https://www.apple.com.cn/shop/order/list'}));
bind('openPayment', async () => { await send('openPayment'); });
bind('acknowledgePayment', async () => { await send('acknowledgePayment'); await refreshState(); notice('已停止付款提醒；付款状态请以官网为准。'); });
bind('continueStep', async () => { await send('resumeStep'); await refreshState(); notice('已继续当前步骤；已提交的订单不会自动重试。'); });
bind('add', async () => {
  const p = products.find(p => p.part_number === $('color').value);
  const targets = [...(state.targets || [])], quantity = Number($('quantity').value);
  const index = targets.findIndex(t => t.part_number === p?.part_number);
  if (index >= 0) targets[index] = {...p, quantity}; else targets.push({...p, quantity});
  await send('saveTargets', {targets: validateTargets(targets)}); await refreshState(); notice('目标已保存，修改目标后需要重新启动监控。');
});
async function startRadar() {
  if (profileDirty) throw new Error('个人资料有修改未保存，请先保存到本机再启动');
  await send('saveSettings', {settings: readSettings()});
  const result = await send('start'); await refreshState(); notice(result.blocked ? '雷达已启动，库存接口冷却中；到期后尝试查询，当前不会下单。' : state.settings?.mode === 'monitor' ? '已启动库存雷达：只扫描和提醒，不提交订单。' : state.settings?.testOnly !== false ? '已启动测试：自动选择自提和填写已保存资料，到订单复核页停止，不提交订单。' : '已启动库存雷达：有货后核对并提交一次订单，成功后每分钟提醒你付款。');
}
bind('start', startRadar);
bind('radar', async () => {
  document.querySelector('input[name=mode][value="rush"]').checked = true;
  $('strategy').value = 'first_available';
  $('testOnly').checked = false; $('fallbackDelivery').checked = false;
  await startRadar();
});
bind('stop', async () => { await send('stop'); await refreshState(); notice('已停止库存监控和未执行的自动动作。'); });
bind('testNotification', async () => { await send('testNotification'); await refreshState(); notice('提醒测试完成，请确认屏幕上是否实际出现通知。'); });
bind('check', async () => {
  $('check').disabled = true;
  try {
    if (!state.monitor?.running) await send('saveSettings', {settings: readSettings()});
    const r = await send('check', {manual: true}); await refreshState();
    notice(r.blocked ? '库存接口冷却中，请等显示的时间再查询；这次没有发送请求。' : r.checkout ? '当前正在锁单或等待你处理，库存扫描已暂停。' : r.backoff || r.throttled ? '还未到下一轮查询时间，本次没有发送请求。' : '库存查询完成；查一次不会执行抢购动作。');
  } finally { render(); }
});
bind('resume', async () => {
  if (!confirm('确认已经处理当前商品？择一购买将停止；分别购买将继续下一目标。这不会将当前商品标记为锁单成功。')) return;
  await send('resumeRush'); await refreshState(); notice('已更新当前任务。');
});
$('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (profileSaving) return;
  profileSaving = true; profileSaveError = ''; renderProfileStatus();
  try {
    const profile = cleanProfile(profileFormValues());
    const submittedSignature = profileSignature();
    await send('saveProfile', {profile});
    await send('saveAutofill', {autofill: $('autofill').checked}); await refreshState();
    if (JSON.stringify(cleanProfile(state.profile)) !== JSON.stringify(profile)) throw new Error('保存后资料发生变化，请核对后重试');
    if (profileSignature() === submittedSignature) loadSavedProfile();
    else { savedFormSignature = JSON.stringify(profileKeys.map(key => profile[key])); profileDirty = profileSignature() !== savedFormSignature; }
    notice('账号和联系人资料已保存到本机，未上传。取货信息确认后再修改资料会暂停订单提交，需要重新核对。');
  } catch (error) { profileSaveError = error.message; profileDirty = true; notice(error.message, true); }
  finally { profileSaving = false; renderProfileStatus(); showProfileToast(); }
});
$('dismissProfileToast').addEventListener('click', hideProfileToast);
$('profileForm').addEventListener('input', () => { hideProfileToast(); profileDirty = profileSignature() !== savedFormSignature; profileSaveError = ''; renderProfileStatus(); });
bind('clear', async () => {
  if (!confirm('清空插件中保存的联系人和地址？原 .env 文件不会修改。')) return;
  await send('clearProfile'); await refreshState(); loadSavedProfile(); profileSaveError = ''; renderProfileStatus();
  notice('插件内的个人信息已清空。');
});
bind('import', async () => $('envFile').click());
$('envFile').addEventListener('change', async () => {
  try {
    const file = $('envFile').files[0]; if (!file) return;
    if (file.size > 65536) throw new Error('环境文件过大');
    const keyMap = {APPLE_ID: 'accountId', CONTACT_LAST_NAME: 'lastName', CONTACT_FIRST_NAME: 'firstName', CONTACT_PHONE: 'phone', CONTACT_EMAIL: 'email', ADDRESS_PROVINCE: 'province', ADDRESS_CITY: 'city', ADDRESS_DISTRICT: 'district', ADDRESS_LINE1: 'line1', ADDRESS_LINE2: 'line2', ADDRESS_POSTCODE: 'postcode'};
    for (let line of (await file.text()).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      line = line.trim(); if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('='); if (at < 0) continue;
      const key = keyMap[line.slice(0, at).trim()]; if (!key) continue;
      let value = line.slice(at + 1).trim();
      if (value.startsWith('"')) value = JSON.parse(value);
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (typeof value !== 'string') throw new Error('地址字段格式无效');
      $('profileForm').elements.namedItem(key).value = value;
    }
    profileDirty = profileSignature() !== savedFormSignature; profileSaveError = ''; renderProfileStatus();
    notice('账号、地址与联系人已导入表单，请检查并保存。密码已忽略。');
  } catch { notice('导入失败，请检查环境文件格式；文件内容未上传。', true); }
  finally { $('envFile').value = ''; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['targets', 'monitor', 'results', 'rushTask', 'stockBlock', 'paymentReminder', 'stockThrottle', 'profile', 'profileSavedAt', 'notificationStatus'].some(key => changes[key])) refreshState().catch(() => {});
});
setInterval(async () => {
  renderRadar();
  if (polling || document.visibilityState !== 'visible' || !state.monitor?.running) return;
  if (state.settings?.mode === 'rush' && state.rushTask && !['stopped', 'waiting_stock'].includes(state.rushTask.stage)) return;
  if (state.monitor.retryAt > Date.now() || state.stockBlock?.until > Date.now()) return;
  if (Date.now() - (state.monitor.lastStartedAt || 0) < effectiveScanInterval(state.settings, state.stockThrottle) * 1000) return;
  polling = true;
  try { await send('check'); } catch { /* 查询错误显示在状态区域，后台自动退避。 */ }
  finally { polling = false; }
}, 250);
await refreshState(); restoreSettings();
for (const key of profileKeys) if (state.profile?.[key]) $('profileForm').elements.namedItem(key).value = state.profile[key];
savedFormSignature = profileSignature(); profileReady = true; renderProfileStatus();
if (state.catalog?.products?.length) {
  for (const p of state.catalog.products) {
    if (!familyCache.has(p.family)) familyCache.set(p.family, []);
    familyCache.get(p.family).push(p);
  }
  options($('family'), [...familyCache.keys()].map(v => [v, familyName(v)]), '选择已读取的系列，或重新读取官网');
  $('catalogTime').textContent = '上次读取：' + new Date(state.catalog.fetchedAt).toLocaleString('zh-CN') + '；预购前请重新读取官网。';
}
