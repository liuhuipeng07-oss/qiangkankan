import {storeURL, loginURL, validateTargets, validateSettings, parsePickup, cleanProfile, validateCheckoutProof, effectiveScanInterval} from './core.js';

const ALARM = 'iphone-pickup';
const PAYMENT_ALARM = 'iphone-payment-reminder';
const WATCHDOG_ALARM = 'iphone-checkout-watchdog';
const STOCK_COOLDOWN = 15 * 60 * 1000;
let checking = false;
let mutating = Promise.resolve();
const defaults = {mode: 'monitor', strategy: 'first_available', interval: 60, postcode: '361000', storeId: '', autofill: true, fallbackDelivery: false, testOnly: true, payment: 'alipay', bank: '', periods: 24};
chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(() => {});

function serial(action) {
  const result = mutating.then(action, action);
  mutating = result.catch(() => {});
  return result;
}

async function request(url, json = false) {
  const u = new URL(url);
  if (u.origin !== 'https://www.apple.com.cn') throw new Error('请求域名无效');
  const r = await fetch(url, {credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000)});
  if (!r.ok) {
    const error = new Error(r.status === 503 ? '官网正在维护或暂时不可用（HTTP 503），库存未知；等待官网恢复后再查询' : r.status === 541 && json ? '库存接口拒绝查询（HTTP 541），已暂停请求 15 分钟；库存未知，可打开官网检查' : `官网请求失败（HTTP ${r.status}），请打开官网检查登录或验证提示`);
    error.httpStatus = r.status;
    if (r.status === 503) {
      const retry = r.headers.get('Retry-After');
      const delay = retry && /^\d+$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
      error.retryDelay = Number.isFinite(delay) ? Math.max(60000, delay) : 60000;
    }
    throw error;
  }
  if (new URL(r.url).origin !== 'https://www.apple.com.cn') throw new Error('官网跳转到了其他域名');
  return json ? r.json() : r.text();
}

async function ensureAlarm() {
  const {monitor, settings, stockThrottle} = await chrome.storage.local.get(['monitor', 'settings', 'stockThrottle']);
  if (monitor?.running) {
    const minutes = effectiveScanInterval(settings, stockThrottle) / 60;
    const old = await chrome.alarms.get(ALARM);
    if (!old || old.periodInMinutes !== minutes) await chrome.alarms.create(ALARM, {periodInMinutes: minutes});
  } else await chrome.alarms.clear(ALARM);
  if (monitor?.running) {
    if (!await chrome.alarms.get(WATCHDOG_ALARM)) await chrome.alarms.create(WATCHDOG_ALARM, {periodInMinutes: 1});
  } else await chrome.alarms.clear(WATCHDOG_ALARM);
  const {paymentReminder} = await chrome.storage.local.get('paymentReminder');
  if (paymentReminder && !paymentReminder.acknowledged) {
    if (!await chrome.alarms.get(PAYMENT_ALARM)) await chrome.alarms.create(PAYMENT_ALARM, {periodInMinutes: 1});
  } else await chrome.alarms.clear(PAYMENT_ALARM);
}

async function desktopNotice(id, options) {
  try {
    if (await chrome.notifications.getPermissionLevel() !== 'granted') throw new Error('disabled');
    await chrome.notifications.create(id, options);
    await chrome.storage.local.set({notificationStatus: {at: Date.now(), ok: true, message: '已交给系统通知；请确认实际看到弹窗，勿扰模式可能隐藏通知。'}});
    return true;
  } catch {
    await chrome.storage.local.set({notificationStatus: {at: Date.now(), ok: false, message: '桌面通知发送失败，请检查浏览器通知权限；付款信息仍保留在面板。'}});
    return false;
  }
}

async function checkCheckoutTimeout() {
  const notice = await serial(async () => {
    const {rushTask: task, monitor, orderAttempts = {}} = await chrome.storage.local.get(['rushTask', 'monitor', 'orderAttempts']);
    if (!monitor?.running || !task) return null;
    const stages = ['preflight', 'product', 'adding', 'bag', 'checkout', 'fulfillment', 'contact', 'billing', 'review', 'submitting'];
    if (!stages.includes(task.stage) || Date.now() - (task.stage === 'submitting' ? task.submittedAt : task.changedAt || task.startedAt) <= 120000) return null;
    const uncertain = task.stage === 'submitting';
    const note = uncertain ? '提交结果未确认，请先查看官网订单；不会重试提交' : '当前购买步骤超过 2 分钟未完成，已暂停；请检查官网页面后继续，尚未提交订单';
    if (uncertain) orderAttempts[task.target.part_number] = {...orderAttempts[task.target.part_number], state: 'uncertain'};
    await chrome.storage.local.set({rushTask: {...task, stage: uncertain ? 'uncertain' : 'manual', changedAt: Date.now(), resumeStage: uncertain ? '' : task.stage === 'adding' ? 'bag' : task.stage, pauseReason: 'timeout', note}, monitor: {...monitor, running: uncertain ? false : monitor.running}, orderAttempts});
    return {id: task.id, uncertain, note};
  });
  if (!notice) return false;
  await ensureAlarm();
  await chrome.action.setBadgeText({text: notice.uncertain ? '待核实' : '需处理'});
  await desktopNotice('task-' + notice.id, {type: 'basic', iconUrl: 'icon.png', title: '库存雷达需要你处理', message: notice.note, requireInteraction: true, priority: 2});
  return true;
}

async function remindPayment() {
  return serial(async () => {
    const {paymentReminder: reminder} = await chrome.storage.local.get('paymentReminder');
    if (!reminder || reminder.acknowledged || Date.now() - (reminder.lastNotifiedAt || 0) < 60000) return;
    await chrome.storage.local.set({paymentReminder: {...reminder, lastNotifiedAt: Date.now()}});
    await chrome.action.setBadgeText({text: '待支付'});
    await chrome.action.setBadgeBackgroundColor({color: '#b45309'});
    await desktopNotice('order-' + reminder.taskId, {
        type: 'basic', iconUrl: 'icon.png', title: '订单已生成，请起来付款',
        message: `${reminder.label} × ${reminder.quantity} · ${reminder.orderNumber}。请在官网查看支付期限并完成付款。`,
        requireInteraction: true, priority: 2,
        buttons: [{title: '打开官网付款'}, {title: '已知晓，停止提醒'}],
      });
  });
}

async function openTaskPage(tabId, paymentOnly = true) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (storeURL(tab.url) && (!paymentOnly || /^\/shop\/(?:checkout|order)(?:\/|$)/.test(new URL(tab.url).pathname))) {
      await chrome.tabs.update(tab.id, {active: true});
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, {focused: true});
      return;
    }
  } catch { /* 原标签页关闭后使用官网订单列表。 */ }
  await chrome.tabs.create({url: 'https://www.apple.com.cn/shop/order/list', active: true});
}

async function acknowledgePayment() {
  await serial(async () => {
    const {paymentReminder} = await chrome.storage.local.get('paymentReminder');
    if (paymentReminder) {
      await chrome.storage.local.set({paymentReminder: {...paymentReminder, acknowledged: true}});
      try { await chrome.notifications.clear('order-' + paymentReminder.taskId); } catch {}
    }
  });
  await ensureAlarm();
}

async function coolingBadge() {
  const {monitor, rushTask} = await chrome.storage.local.get(['monitor', 'rushTask']);
  if (monitor?.running && !['submitting', 'ordered', 'uncertain'].includes(rushTask?.stage)) {
    await chrome.action.setBadgeText({text: '冷却'});
    await chrome.action.setBadgeBackgroundColor({color: '#b45309'});
  }
}

async function stop() {
  await serial(async () => {
    const {monitor, rushTask, orderAttempts = {}} = await chrome.storage.local.get(['monitor', 'rushTask', 'orderAttempts']);
    let task = rushTask;
    if (task?.stage === 'submitting') {
      task = {...task, stage: 'uncertain', note: '已停止；订单提交结果需在官网核实，不会再次自动提交'};
      orderAttempts[task.target.part_number] = {...orderAttempts[task.target.part_number], state: 'uncertain'};
    } else if (task && !['ordered', 'uncertain'].includes(task.stage)) task = {...task, stage: 'stopped', note: '已停止自动动作'};
    await chrome.storage.local.set({monitor: {...monitor, runId: crypto.randomUUID(), running: false, stoppedAt: Date.now()}, rushTask: task, orderAttempts});
  });
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await chrome.action.setBadgeText({text: ''});
}

async function notify(target, row) {
  const store = row.stores.find(s => s.state === 'available');
  try {
    await chrome.notifications.create('stock-' + target.part_number, {
      type: 'basic', iconUrl: 'icon.png', title: '厦门自提有货',
      message: `${target.model} ${target.capacity} ${target.color} · ${store.name}。购买 ${target.quantity} 台的数量需结账确认。`,
    });
  } catch { /* Windows 关闭系统通知时仍保留面板库存结果。 */ }
}

async function openRush(target, row, monitor, settings) {
  return serial(async () => {
    const current = await chrome.storage.local.get(['monitor', 'rushTask', 'orderAttempts']);
    if (!current.monitor?.running || current.monitor.runId !== monitor.runId || current.rushTask?.stage && !['stopped', 'waiting_stock'].includes(current.rushTask.stage)) return;
    if (current.orderAttempts?.[target.part_number]) return;
    const store = row.stores.find(s => s.state === 'available');
    // 创建后台页并先写入任务，再加载商品，避免内容脚本先于任务启动。
    let tab;
    if (current.rushTask?.stage === 'waiting_stock') try { const previous = await chrome.tabs.get(current.rushTask.tabId); if (storeURL(previous.url)) tab = previous; } catch {}
    if (!tab) tab = await chrome.tabs.create({url: 'about:blank', active: true});
    await chrome.storage.local.set({rushTask: {id: crypto.randomUUID(), tabId: tab.id, target, store, fulfillmentMode: 'pickup', fallbackDelivery: false, testOnly: settings.testOnly, plan: {payment: settings.payment, bank: settings.bank, periods: settings.periods}, stage: 'preflight', changedAt: Date.now(), startedAt: Date.now(), note: '已检测到厦门有货，先检查原购物袋，避免连带购买已有商品'}});
    await chrome.tabs.update(tab.id, {url: 'https://www.apple.com.cn/shop/bag'});
  });
}

async function check(manual = false) {
  if (checking) return {busy: true};
  checking = true;
  let snapshot;
  try {
    await checkCheckoutTimeout();
    snapshot = await chrome.storage.local.get(['monitor', 'targets', 'settings', 'results', 'rushTask', 'stockBlock', 'stockThrottle']);
    const settings = validateSettings({...defaults, ...snapshot.settings});
    const targets = validateTargets(snapshot.targets);
    const monitor = snapshot.monitor || {};
    if (!manual && !monitor.running) return {stopped: true};
    if (settings.mode === 'rush' && snapshot.rushTask && !['stopped', 'waiting_stock'].includes(snapshot.rushTask.stage)) return {checkout: true};
    if (snapshot.stockBlock?.until > Date.now()) {
      const hold = snapshot.stockBlock;
      await serial(async () => {
        const current = (await chrome.storage.local.get('monitor')).monitor || {};
        if (current.runId === monitor.runId && (current.retryAt !== hold.until || current.error !== hold.message)) await chrome.storage.local.set({monitor: {...current, error: hold.message, retryAt: hold.until}});
      });
      await coolingBadge();
      return {blocked: true, retryAt: hold.until, error: hold.message};
    }
    if (monitor.retryAt > Date.now()) return {backoff: true};
    if (monitor.lastStartedAt && Date.now() - monitor.lastStartedAt < effectiveScanInterval(settings, snapshot.stockThrottle) * 1000) return {throttled: true};
    await serial(async () => {
      const current = (await chrome.storage.local.get('monitor')).monitor || {};
      await chrome.storage.local.set({monitor: {...current, lastStartedAt: Date.now()}});
    });
    const rows = [];
    for (let i = 0; i < targets.length; i += 8) {
      const batch = targets.slice(i, i + 8);
      const q = new URLSearchParams({pl: 'true', location: settings.postcode, searchNearby: 'true'});
      batch.forEach((t, n) => { q.set('parts.' + n, t.part_number); q.set('mts.' + n, 'regular'); });
      const data = await request('https://www.apple.com.cn/shop/retail/pickup-message?' + q, true);
      rows.push(...parsePickup(data, batch, settings.storeId));
    }
    const checkedAt = Date.now();
    await serial(async () => {
      const current = (await chrome.storage.local.get('monitor')).monitor || {};
      if (current.runId !== monitor.runId) return;
      await chrome.storage.local.set({results: {checkedAt, rows}, stockBlock: null, monitor: {...current, scans: (current.scans || 0) + 1, error: '', failures: 0, retryAt: 0}});
    });
    const current = (await chrome.storage.local.get('monitor')).monitor;
    const active = !manual && monitor.running && current?.running && current.runId === monitor.runId;
    if (active) {
      for (const row of rows) {
        const old = snapshot.results?.rows?.find(r => r.part_number === row.part_number);
        if (row.state === 'available' && old?.state !== 'available') await notify(targets.find(t => t.part_number === row.part_number), row);
      }
      if (settings.mode === 'rush') {
        const row = rows.find(r => r.state === 'available' && !current.handledParts?.includes(r.part_number) && !(current.stockRetryAt?.[r.part_number] > Date.now()));
        if (row) await openRush(targets.find(t => t.part_number === row.part_number), row, monitor, settings);
      }
      await chrome.action.setBadgeText({text: rows.some(r => r.state === 'available') ? '有货' : '监控'});
      await chrome.action.setBadgeBackgroundColor({color: '#137b65'});
    }
    return {checkedAt, rows};
  } catch (error) {
    await serial(async () => {
      const data = await chrome.storage.local.get(['monitor', 'results', 'stockBlock', 'stockThrottle']);
      const current = data.monitor || {};
      let hold = data.stockBlock;
      if ([541, 503].includes(error.httpStatus)) {
        const at = Date.now();
        let delay;
        if (error.httpStatus === 541) {
          const prior = data.stockThrottle;
          const strikes = prior?.lastAt > at - 2 * 60 * 60 * 1000 ? Math.min(3, (prior.strikes || 0) + 1) : 1;
          delay = STOCK_COOLDOWN * 2 ** (strikes - 1);
          const throttle = {strikes, lastAt: at};
          await chrome.storage.local.set({stockThrottle: throttle});
          error.message = `库存接口拒绝查询（HTTP 541），已暂停请求 ${delay / 60000} 分钟；恢复后至少 ${effectiveScanInterval(snapshot?.settings, throttle)} 秒一轮，库存未知`;
        } else delay = Math.max(error.retryDelay || 60000, Math.min(900, 30 * 2 ** Math.min((current.failures || 0) + 1, 5)) * 1000);
        hold = {at, until: Math.max(at + delay, hold?.until || 0), status: error.httpStatus, message: error.message};
        await chrome.storage.local.set({stockBlock: hold});
      }
      if (data.results) await chrome.storage.local.set({results: {...data.results, stale: true, failedAt: Date.now()}});
      if (snapshot && current.runId !== snapshot.monitor?.runId) return;
      const failures = (current.failures || 0) + 1;
      await chrome.storage.local.set({monitor: {...current, error: String(error.message || '查询失败').slice(0, 250), failures, retryAt: hold?.until > Date.now() ? hold.until : Date.now() + Math.min(900, 30 * 2 ** Math.min(failures, 5)) * 1000}});
    });
    if ([541, 503].includes(error.httpStatus)) { await coolingBadge(); await ensureAlarm(); }
    throw error;
  } finally { checking = false; }
}

function panelSender(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
}

async function dispatch(message, sender) {
  if (message.type === 'loginProfile') {
    if (!sender.tab || !loginURL(sender.url)) throw new Error('登录页面无效');
    const {loginIntent} = await chrome.storage.session.get('loginIntent');
    const {profile, rushTask, monitor} = await chrome.storage.local.get(['profile', 'rushTask', 'monitor']);
    const explicitIntent = loginIntent?.tabId === sender.tab.id && loginIntent.expiresAt >= Date.now();
    const checkoutIntent = monitor?.running && rushTask?.tabId === sender.tab.id && (rushTask.stage === 'checkout' || rushTask.stage === 'manual' && (rushTask.pauseReason === 'login' || rushTask.note?.startsWith('官网要求登录 / 验证')));
    if (!explicitIntent && !checkoutIntent) return {accountId: ''};
    return {accountId: cleanProfile(profile).accountId};
  }
  if (message.type === 'contentState') {
    if (!sender.tab || !storeURL(sender.url)) throw new Error('页面不可访问本地信息');
    const {settings, profile, rushTask, monitor, profileRevision = 0} = await chrome.storage.local.get(['settings', 'profile', 'rushTask', 'monitor', 'profileRevision']);
    const formPage = /^\/shop\/(checkout|account)(\/|$)/.test(new URL(sender.url).pathname);
    return {autofill: Boolean(settings?.autofill), profile: settings?.autofill && formPage ? cleanProfile(profile) : null, profileRevision,
      task: rushTask?.tabId === sender.tab.id && (monitor?.running || rushTask.stage === 'uncertain') ? rushTask : null};
  }
  if (message.type === 'resumeAfterLogin') {
    if (!sender.tab || !storeURL(sender.url)) throw new Error('结账页面无效');
    const url = new URL(sender.url);
    if (url.pathname !== '/shop/checkout' || !/^Fulfillment(?:-|$)/i.test(url.searchParams.get('_s') || '')) return {accepted: false};
    return serial(async () => {
      const {rushTask, monitor, orderAttempts} = await chrome.storage.local.get(['rushTask', 'monitor', 'orderAttempts']);
      const loginPause = rushTask?.pauseReason === 'login' || rushTask?.note?.startsWith('官网要求登录 / 验证');
      if (!monitor?.running || rushTask?.id !== message.id || rushTask.tabId !== sender.tab.id || rushTask.stage !== 'manual' || rushTask.resumeStage !== 'checkout' || !loginPause || orderAttempts?.[rushTask.target.part_number] || !rushTask.bagProof) return {accepted: false};
      validateCheckoutProof(rushTask.target, rushTask.bagProof);
      await chrome.storage.local.set({rushTask: {...rushTask, stage: 'checkout', changedAt: Date.now(), pauseReason: '', manualStepConfirmed: false, note: '已到官网取货 / 配送步骤，自动恢复结账并选择厦门自提'}});
      return {accepted: true};
    });
  }
  if (message.type === 'taskUpdate') {
    if (!sender.tab || !storeURL(sender.url)) throw new Error('页面无效');
    const result = await serial(async () => {
      const {rushTask, monitor, settings, profile, orderAttempts = {}, profileRevision = 0} = await chrome.storage.local.get(['rushTask', 'monitor', 'settings', 'profile', 'orderAttempts', 'profileRevision']);
      const lateReceipt = rushTask?.stage === 'uncertain' && message.stage === 'ordered';
      if ((!monitor?.running && !lateReceipt) || !rushTask || rushTask.id !== message.id || rushTask.tabId !== sender.tab.id || rushTask.stage !== message.from) return {accepted: false};
      if (message.stage === 'adding' && sender.url !== rushTask.target.url) throw new Error('当前页面与目标 SKU 不匹配');
      if (['delivery', 'shipping'].includes(message.stage)) throw new Error('库存雷达只支持厦门自提，不会创建配送订单');
      const transitions = {preflight: ['product', 'bag', 'manual'], product: ['adding', 'manual'], adding: ['bag', 'manual'], bag: ['checkout', 'manual'], checkout: ['fulfillment', 'manual'], fulfillment: ['contact', 'waiting_stock', 'manual'], contact: ['billing', 'manual'], billing: ['review', 'manual'], review: ['submitting', 'manual'], submitting: ['ordered', 'uncertain'], ordered: [], uncertain: ['ordered'], manual: [], waiting_stock: []};
      if (!transitions[rushTask.stage]?.includes(message.stage)) throw new Error('任务状态无效');
      const extra = {}, extraState = {};
      if (message.stage === 'fulfillment') extra.manualStepConfirmed = false;
      if (message.stage === 'checkout') extra.bagProof = validateCheckoutProof(rushTask.target, message.proof);
      if (message.stage === 'delivery') {
        if (!rushTask.fallbackDelivery || orderAttempts[rushTask.target.part_number] || !['store_unavailable', 'no_dates', 'no_slots'].includes(message.reason)) throw new Error('当前不能切换配送');
        extra.fulfillmentMode = 'delivery'; extra.pickup = null; extra.deliveryReason = message.reason;
      }
      if (message.stage === 'shipping') {
        if (rushTask.fulfillmentMode !== 'delivery' || message.deliverySelected !== true) throw new Error('未确认配送方式');
        extra.deliveryConfirmed = true;
      }
      if (message.stage === 'contact') {
        if (message.pickup?.storeId !== rushTask.store.id) throw new Error('选中的自提门店与厦门目标门店不符');
        extra.pickup = {storeId: rushTask.store.id, date: String(message.pickup.date || '').slice(0, 80), slot: String(message.pickup.slot || '').slice(0, 120)};
      }
      if (message.stage === 'billing') {
        if (message.profileRevision !== profileRevision) throw new Error('取货资料在核对期间发生变化，请重新检查');
        if (rushTask.fulfillmentMode === 'delivery') {
          const expected = cleanProfile(profile);
          const keys = ['lastName', 'firstName', 'phone', 'email', 'province', 'city', 'district', 'line1', 'postcode'];
          if (!rushTask.deliveryConfirmed || keys.some(k => !expected[k] || message.address?.[k] !== expected[k]) || (expected.line2 || '') !== (message.address?.line2 || '')) throw new Error('配送地址与保存资料不符或不完整');
          extra.addressVerified = true;
        }
        extra.contactVerified = true; extra.contactRevision = profileRevision;
      }
      if (message.stage === 'review') {
        const payment = message.payment;
        const plan = rushTask.plan;
        const allowed = plan.payment === 'alipay' ? payment?.method === 'ALIPAY' : plan.payment === 'wechat' ? payment?.method === 'WECHAT' : payment?.method === 'ALIPAY' || payment?.method === 'INSTALLMENT' && payment.bank === plan.bank && payment.periods === plan.periods && payment.zeroFee === true;
        if (!allowed) throw new Error('付款方式与设置不符');
        extra.payment = {method: payment.method, bank: String(payment.bank || ''), periods: Number(payment.periods || 0), zeroFee: Boolean(payment.zeroFee)};
      }
      if (message.stage === 'submitting') {
        if (rushTask.testOnly !== false) throw new Error('测试模式不提交订单，请关闭测试开关并重新启动后再实际下单');
        extra.reviewProof = validateCheckoutProof(rushTask.target, message.proof);
        const fulfillmentVerified = Boolean(rushTask.store?.id) && rushTask.fulfillmentMode !== 'delivery' && rushTask.pickup?.storeId === rushTask.store.id && rushTask.pickup?.date && rushTask.pickup?.slot;
        if (!rushTask.bagProof || !fulfillmentVerified || message.pickupProof?.storeId !== rushTask.store.id || !rushTask.contactVerified || !rushTask.payment) throw new Error('订单复核条件不完整，必须确认所选厦门门店自提');
        if (rushTask.contactRevision !== profileRevision) throw new Error('联系人资料已变化，请重新核对订单');
        if (orderAttempts[rushTask.target.part_number]) throw new Error('此 SKU 已有提交记录，不会重复下单');
        extra.submittedAt = Date.now();
        orderAttempts[rushTask.target.part_number] = {taskId: rushTask.id, quantity: rushTask.target.quantity, state: 'submitting', createdAt: Date.now()};
      }
      let updatedMonitor = monitor;
      if (message.stage === 'waiting_stock') {
        if (!['store_unavailable', 'no_dates', 'no_slots'].includes(message.reason) || orderAttempts[rushTask.target.part_number]) throw new Error('当前不能重新扫描库存');
        updatedMonitor = {...monitor, stockRetryAt: {...monitor.stockRetryAt, [rushTask.target.part_number]: Date.now() + 60000}};
      }
      if (message.stage === 'ordered') {
        if (!/^W\d{8,12}$/.test(message.orderNumber || '')) throw new Error('没有有效的官网订单号');
        extra.orderNumber = message.orderNumber;
        orderAttempts[rushTask.target.part_number] = {...orderAttempts[rushTask.target.part_number], state: 'ordered', orderNumber: message.orderNumber};
        updatedMonitor = {...monitor, handledParts: [...new Set([...(monitor.handledParts || []), rushTask.target.part_number])], running: Boolean(monitor.running && settings?.strategy === 'each_target')};
        extraState.paymentReminder = {taskId: rushTask.id, tabId: rushTask.tabId, part: rushTask.target.part_number, label: `${rushTask.target.model} ${rushTask.target.capacity} ${rushTask.target.color}`.trim(), quantity: rushTask.target.quantity, orderNumber: message.orderNumber, createdAt: Date.now(), lastNotifiedAt: 0, acknowledged: false};
      }
      if (message.stage === 'uncertain') {
        orderAttempts[rushTask.target.part_number] = {...orderAttempts[rushTask.target.part_number], state: 'uncertain'};
        updatedMonitor = {...monitor, running: false};
      }
      if (message.stage === 'manual') extra.resumeStage = rushTask.stage === 'adding' ? 'bag' : ['preflight', 'product', 'bag', 'checkout', 'fulfillment', 'delivery', 'shipping', 'contact', 'billing', 'review'].includes(rushTask.stage) ? rushTask.stage : '';
      if (message.stage === 'manual') extra.pauseReason = String(message.note || '').startsWith('官网要求登录 / 验证') ? 'login' : '';
      await chrome.storage.local.set({...extraState, rushTask: {...rushTask, ...extra, stage: message.stage, changedAt: Date.now(), note: String(message.note || '').slice(0, 200)}, monitor: updatedMonitor, orderAttempts});
      if (['ordered', 'uncertain'].includes(message.stage)) {
        await ensureAlarm();
        await chrome.action.setBadgeText({text: message.stage === 'ordered' ? '待支付' : '待核实'});
        if (message.stage === 'uncertain') await desktopNotice('order-' + rushTask.id, {type: 'basic', iconUrl: 'icon.png', title: '订单结果需要核实', message: '提交动作不会重试。请先查看官网订单列表，避免重复下单。', requireInteraction: true, priority: 2});
      }
      if (message.stage === 'manual') await desktopNotice('task-' + rushTask.id, {type: 'basic', iconUrl: 'icon.png', title: '库存雷达需要你处理', message: String(message.note || '请回到购买页面核对').slice(0, 200), requireInteraction: true, priority: 2});
      return {accepted: true};
    });
    if (result.accepted && message.stage === 'ordered') await remindPayment();
    return result;
  }
  if (!panelSender(sender)) throw new Error('仅插件面板可执行此操作');
  if (message.type === 'state') return chrome.storage.local.get(['settings', 'targets', 'profile', 'profileSavedAt', 'results', 'monitor', 'rushTask', 'catalog', 'orderAttempts', 'stockBlock', 'paymentReminder', 'stockThrottle', 'notificationStatus']);
  if (message.type === 'testNotification') return {sent: await desktopNotice('notification-test', {type: 'basic', iconUrl: 'icon.png', title: '库存雷达 · 提醒测试', message: '这是一条测试提醒，没有创建订单。请确认你能看到此通知。', requireInteraction: true})};
  if (message.type === 'openPayment') {
    const {paymentReminder} = await chrome.storage.local.get('paymentReminder');
    if (!paymentReminder) throw new Error('当前没有已确认的订单');
    await openTaskPage(paymentReminder.tabId);
    return {opened: true};
  }
  if (message.type === 'acknowledgePayment') { await acknowledgePayment(); return {acknowledged: true}; }
  if (message.type === 'inspectWebsite') {
    const {targets} = await chrome.storage.local.get('targets');
    const url = targets?.length ? validateTargets(targets)[0].url : 'https://www.apple.com.cn/shop/buy-iphone';
    const tabs = await chrome.tabs.query({url: 'https://www.apple.com.cn/shop/buy-iphone/*'});
    const existing = tabs.find(tab => tab.url === url);
    if (existing) await chrome.tabs.update(existing.id, {active: true});
    else await chrome.tabs.create({url, active: true});
    return {opened: true};
  }
  if (message.type === 'quickLogin') {
    const {rushTask, profile} = await chrome.storage.local.get(['rushTask', 'profile']);
    let tab, reuse = false;
    if (rushTask?.tabId && rushTask.stage === 'manual') {
      try { const candidate = await chrome.tabs.get(rushTask.tabId); if (storeURL(candidate.url) && (/signin/i.test(candidate.url) || new URL(candidate.url).pathname === '/shop/checkout' && (rushTask.pauseReason === 'login' || rushTask.note?.startsWith('官网要求登录 / 验证')))) { tab = candidate; reuse = true; } } catch {}
    }
    if (!tab) tab = await chrome.tabs.create({url: 'about:blank', active: true});
    await chrome.storage.session.set({loginIntent: {tabId: tab.id, expiresAt: Date.now() + 600000}});
    await chrome.tabs.update(tab.id, reuse ? {active: true} : {url: 'https://www.apple.com.cn/shop/account/home', active: true});
    return {opened: true, reusedCheckout: reuse, accountSaved: Boolean(cleanProfile(profile).accountId)};
  }
  if (message.type === 'saveAutofill') {
    const {settings} = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({settings: {...defaults, ...settings, autofill: Boolean(message.autofill)}});
    return {saved: true};
  }
  if (message.type === 'page') {
    if (!/^\/shop\/buy-iphone(?:\/iphone-[a-z0-9-]+)?$/.test(message.path)) throw new Error('型号页面无效');
    return {html: await request('https://www.apple.com.cn' + message.path)};
  }
  if (message.type === 'saveTargets') {
    await stop();
    const targets = validateTargets(message.targets);
    await chrome.storage.local.set({targets, results: null, rushTask: null});
    return {saved: true};
  }
  if (message.type === 'saveSettings') {
    await stop();
    await chrome.storage.local.set({settings: validateSettings(message.settings)});
    return {saved: true};
  }
  if (message.type === 'saveProfile') {
    return serial(async () => {
      const {profileRevision = 0} = await chrome.storage.local.get('profileRevision');
      const profile = cleanProfile(message.profile), savedAt = Date.now();
      await chrome.storage.local.set({profile, profileSavedAt: savedAt, profileRevision: profileRevision + 1});
      const stored = await chrome.storage.local.get('profile');
      if (Object.keys(profile).some(key => stored.profile?.[key] !== profile[key])) throw new Error('未能确认资料已保存，请重试');
      return {saved: true, savedAt};
    });
  }
  if (message.type === 'clearProfile') {
    const {profileRevision = 0} = await chrome.storage.local.get('profileRevision');
    await chrome.storage.local.remove(['profile', 'profileSavedAt']);
    await chrome.storage.local.set({profileRevision: profileRevision + 1});
    return {saved: true};
  }
  if (message.type === 'saveCatalog') {
    const catalog = message.catalog;
    if (!Array.isArray(catalog) || catalog.length > 1000) throw new Error('型号目录无效');
    await chrome.storage.local.set({catalog: {products: catalog, fetchedAt: Date.now()}});
    return {saved: true};
  }
  if (message.type === 'start') {
    await serial(async () => {
      const data = await chrome.storage.local.get(['targets', 'settings', 'orderAttempts', 'paymentReminder', 'profile', 'monitor']);
      const targets = validateTargets(data.targets), settings = validateSettings({...defaults, ...data.settings});
      if (settings.mode === 'rush' && targets.some(t => data.orderAttempts?.[t.part_number])) throw new Error('所选 SKU 已有订单提交记录，请先在官网核实；不会自动重复下单');
      if (settings.mode === 'rush' && data.paymentReminder && !data.paymentReminder.acknowledged) throw new Error('已有订单提醒待处理，请先查看官网订单并知晓付款提醒');
      if (settings.mode === 'rush' && targets.some(t => !(t.price_cny > 0))) throw new Error('请重新读取官网价格后再启动锁单');
      if (settings.mode === 'rush' && settings.testOnly === false) {
        const p = cleanProfile(data.profile), labels = {lastName: '姓', firstName: '名', phone: '联系电话', email: '联系邮箱'};
        const missing = Object.keys(labels).filter(key => !p[key]).map(key => labels[key]);
        if (missing.length) throw new Error('启动前请先保存提货资料，还缺：' + missing.join('、'));
        if (!/^[+\d][\d\s()-]{5,24}$/.test(p.phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new Error('请检查并保存有效的联系电话和联系邮箱');
        if (!settings.autofill) throw new Error('自动锁单需要开启“自动填写空白字段”');
      }
      await chrome.storage.local.set({monitor: {running: true, runId: crypto.randomUUID(), startedAt: Date.now(), lastStartedAt: data.monitor?.lastStartedAt || 0, retryAt: data.monitor?.retryAt || 0, failures: data.monitor?.failures || 0, stockRetryAt: data.monitor?.stockRetryAt || {}}, results: null, rushTask: null});
    });
    await ensureAlarm();
    const result = await check();
    return {started: true, blocked: Boolean(result.blocked), retryAt: result.retryAt};
  }
  if (message.type === 'stop') { await stop(); return {stopped: true}; }
  if (message.type === 'check') return check(Boolean(message.manual));
  if (message.type === 'resumeRush') {
    const proceed = await serial(async () => {
      const {rushTask, settings, targets, monitor} = await chrome.storage.local.get(['rushTask', 'settings', 'targets', 'monitor']);
      if (!rushTask || !['manual', 'stopped', 'ordered'].includes(rushTask.stage)) throw new Error('当前没有可确认的任务，或订单结果尚未核实');
      // 用户明确确认已处理当前商品后再进入下一个目标，不能将打开页面当作下单成功。
      const handledParts = [...new Set([...(monitor?.handledParts || []), rushTask.target.part_number])];
      const remaining = (targets || []).filter(t => !handledParts.includes(t.part_number));
      await chrome.storage.local.set({monitor: {...monitor, handledParts, lastStartedAt: 0}, rushTask: null});
      return Boolean(monitor?.running && settings?.strategy === 'each_target' && remaining.length);
    });
    if (proceed) await check(); else await stop();
    return {saved: true};
  }
  if (message.type === 'resumeStep') {
    return serial(async () => {
      const {rushTask, monitor, orderAttempts} = await chrome.storage.local.get(['rushTask', 'monitor', 'orderAttempts']);
      if (!monitor?.running || rushTask?.stage !== 'manual' || !rushTask.resumeStage || orderAttempts?.[rushTask.target.part_number]) throw new Error('此步骤不能自动重试，请先核实官网订单');
      if (rushTask.testOnly !== false && rushTask.resumeStage === 'review') throw new Error('测试已经到订单复核页，不会提交订单');
      await chrome.storage.local.set({rushTask: {...rushTask, stage: rushTask.resumeStage, changedAt: Date.now(), pauseReason: '', manualStepConfirmed: true, note: '已恢复当前步骤，继续核对官网页面'}});
      if (['bag', 'preflight'].includes(rushTask.resumeStage)) {
        const tab = await chrome.tabs.get(rushTask.tabId);
        if (!/^\/shop\/bag(\/|$)/.test(new URL(tab.url).pathname)) await chrome.tabs.update(tab.id, {url: 'https://www.apple.com.cn/shop/bag'});
      }
      return {resumed: true};
    });
  }
  if (message.type === 'releaseAttempt') {
    return serial(async () => {
      const {monitor, orderAttempts = {}} = await chrome.storage.local.get(['monitor', 'orderAttempts']);
      if (monitor?.running) throw new Error('请先停止自动操作并核实原订单');
      delete orderAttempts[message.part];
      await chrome.storage.local.set({orderAttempts});
      return {released: true};
    });
  }
  throw new Error('未知操作');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  dispatch(message, sender).then(data => respond({ok: true, data}), error => respond({ok: false, error: error.message || '操作失败'}));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WATCHDOG_ALARM) checkCheckoutTimeout().catch(() => {});
  if (alarm.name === ALARM) check().catch(() => {});
  if (alarm.name === PAYMENT_ALARM) remindPayment().catch(() => {});
});
chrome.notifications.onClicked.addListener(async id => {
  const {paymentReminder, rushTask} = await chrome.storage.local.get(['paymentReminder', 'rushTask']);
  if (paymentReminder && id === 'order-' + paymentReminder.taskId) await openTaskPage(paymentReminder.tabId);
  else if (rushTask && [ 'task-' + rushTask.id, 'order-' + rushTask.id].includes(id)) await openTaskPage(rushTask.tabId, false);
});
chrome.notifications.onButtonClicked.addListener(async (id, button) => {
  const {paymentReminder} = await chrome.storage.local.get('paymentReminder');
  if (!paymentReminder || id !== 'order-' + paymentReminder.taskId) return;
  if (button === 0) await openTaskPage(paymentReminder.tabId);
  if (button === 1) await acknowledgePayment();
});
chrome.runtime.onStartup.addListener(() => ensureAlarm().catch(() => {}));
chrome.runtime.onInstalled.addListener(async details => {
  const {settings, monitor, stockBlock, results, rushTask, orderAttempts, stockThrottle} = await chrome.storage.local.get(['settings', 'monitor', 'stockBlock', 'results', 'rushTask', 'orderAttempts', 'stockThrottle']);
  if (!settings) await chrome.storage.local.set({settings: defaults, targets: []});
  else if (details.reason === 'update') await chrome.storage.local.set({settings: validateSettings({...defaults, ...settings})});
  if (details.reason === 'update' && !stockThrottle && stockBlock?.status === 541) await chrome.storage.local.set({stockThrottle: {strikes: 1, lastAt: stockBlock.at}});
  if (details.reason === 'update' && !stockBlock && /HTTP 541/.test(monitor?.error || '') && monitor.lastStartedAt + STOCK_COOLDOWN > Date.now()) {
    await chrome.storage.local.set({stockBlock: {at: monitor.lastStartedAt, until: monitor.lastStartedAt + STOCK_COOLDOWN, status: 541, message: '库存接口拒绝查询（HTTP 541），已暂停请求 15 分钟；库存未知，可打开官网检查'}, ...(results ? {results: {...results, stale: true}} : {})});
  }
  let preserveLoginPause = false;
  if (details.reason === 'update' && monitor?.running && rushTask?.stage === 'manual' && rushTask.resumeStage === 'checkout' && (rushTask.pauseReason === 'login' || rushTask.note?.startsWith('官网要求登录 / 验证')) && rushTask.bagProof && !orderAttempts?.[rushTask.target.part_number]) {
    try {
      validateCheckoutProof(rushTask.target, rushTask.bagProof);
      const tab = await chrome.tabs.get(rushTask.tabId), url = new URL(tab.url);
      preserveLoginPause = storeURL(tab.url) && url.pathname === '/shop/checkout' && /^(?:Fulfillment|SignIn)(?:-|$)/i.test(url.searchParams.get('_s') || '');
    } catch { /* 无法核实原结账页时保持常规停止行为。 */ }
  }
  if (details.reason === 'update' && preserveLoginPause) await chrome.storage.local.set({settings: validateSettings({...defaults, ...settings}), rushTask: {...rushTask, fallbackDelivery: false, testOnly: settings?.testOnly !== false}});
  const preserveScan = monitor?.running && (!rushTask || ['stopped', 'waiting_stock'].includes(rushTask.stage));
  if (details.reason === 'update' && !preserveLoginPause && !preserveScan) await stop();
  await ensureAlarm();
});
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const {rushTask, monitor, orderAttempts = {}} = await chrome.storage.local.get(['rushTask', 'monitor', 'orderAttempts']);
  if (rushTask?.tabId !== tabId || ['manual', 'stopped', 'ordered', 'uncertain'].includes(rushTask.stage)) return;
  if (rushTask.stage === 'submitting') {
    orderAttempts[rushTask.target.part_number] = {...orderAttempts[rushTask.target.part_number], state: 'uncertain'};
    await chrome.storage.local.set({rushTask: {...rushTask, stage: 'uncertain', note: '提交后页面已关闭，请先查看官网订单；不会重复提交'}, monitor: {...monitor, running: false}, orderAttempts});
    await ensureAlarm();
  } else await chrome.storage.local.set({rushTask: {...rushTask, stage: 'manual', resumeStage: '', note: '购买页面已关闭，请本人检查购物袋；尚未提交订单'}});
}).catch(() => {}));
ensureAlarm().catch(() => {});
