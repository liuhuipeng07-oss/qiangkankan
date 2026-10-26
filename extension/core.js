export function storeURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && (['www.apple.com.cn', 'store.apple.com.cn'].includes(u.hostname) || /^secure\d*\.(www|store)\.apple\.com\.cn$/.test(u.hostname));
  } catch { return false; }
}

export function validateTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 32) throw new Error('请选择 1–32 个 SKU');
  const seen = new Set();
  return targets.map(t => {
    const part = String(t.part_number || '').toUpperCase();
    const quantity = Number(t.quantity);
    if (!/^[A-Z0-9]{5,14}\/[A-Z]$/.test(part) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999 || seen.has(part)) throw new Error('SKU 或数量无效，或存在重复 SKU');
    const u = new URL(t.url);
    if (u.origin !== 'https://www.apple.com.cn' || !/^\/shop\/buy-iphone\/iphone-[a-z0-9-]+\/[a-z0-9]+\/[a-z]$/.test(u.pathname) || !u.pathname.toUpperCase().endsWith('/' + part) || u.search || u.hash) throw new Error('商品链接与 SKU 不匹配');
    seen.add(part);
    return {part_number: part, quantity, url: u.href, model: String(t.model || ''), capacity: String(t.capacity || ''), color: String(t.color || ''), price_cny: Number(t.price_cny) || 0, sale_notice: String(t.sale_notice || '').slice(0, 250)};
  });
}

export function validateSettings(s) {
  if (!['monitor', 'rush'].includes(s.mode)) throw new Error('请选择模式');
  if (!['first_available', 'each_target'].includes(s.strategy)) throw new Error('购买方式无效');
  const interval = Number(s.interval);
  if (![1, 3, 5, 10, 30, 60, 120, 300].includes(interval)) throw new Error('检查间隔无效');
  const postcode = String(s.postcode || '').trim();
  if (!/^361\d{3}$/.test(postcode)) throw new Error('请输入厦门的六位邮政编码');
  const payment = String(s.payment || 'alipay');
  const periods = Number(s.periods || 24);
  if (!['alipay', 'wechat', 'installment_or_alipay'].includes(payment) || ![3, 6, 12, 24].includes(periods)) throw new Error('付款方式或分期期数无效');
  return {mode: s.mode, strategy: s.strategy, interval: Math.max(60, interval), postcode, storeId: String(s.storeId || ''), autofill: Boolean(s.autofill), fallbackDelivery: false, testOnly: s.testOnly !== false, payment, bank: String(s.bank || '').trim().slice(0, 80), periods};
}

export function effectiveScanInterval(settings, throttle, now = Date.now()) {
  const base = Math.max(60, Number(settings?.interval) || 60);
  if (!throttle?.lastAt || now - throttle.lastAt >= 2 * 60 * 60 * 1000) return base;
  return Math.max(base, throttle.strikes >= 3 ? 300 : throttle.strikes >= 2 ? 120 : 60);
}

export function parsePickup(data, targets, storeId = '') {
  if (data?.head?.status && Number(data.head.status) !== 200) throw new Error('官网返回了库存查询错误');
  if (data?.body?.errorMessage) throw new Error(String(data.body.errorMessage).slice(0, 150));
  if (!Array.isArray(data?.body?.stores) || !data.body.stores.length) throw new Error('官网未返回门店，不能判断库存');
  const stores = data.body.stores.filter(s => String(s.city || s.retailStore?.address?.city || '').replace(/市$/, '') === '厦门' && (!storeId || s.storeNumber === storeId));
  if (!stores.length) throw new Error('查询结果中没有所选厦门门店');
  return targets.map(t => {
    const results = stores.map(s => {
      const a = s.partsAvailability?.[t.part_number];
      const token = a?.pickupDisplay;
      const state = token === 'available' && a.storePickEligible !== false ? 'available' : ['unavailable', 'ineligible'].includes(token) ? 'unavailable' : 'unknown';
      return {id: s.storeNumber, name: s.storeName, state, quote: String(a?.pickupSearchQuote || a?.messageTypes?.regular?.storePickupQuote || '状态未知')};
    });
    return {part_number: t.part_number, state: results.some(s => s.state === 'available') ? 'available' : results.every(s => s.state === 'unavailable') ? 'unavailable' : 'unknown', stores: results};
  });
}

export function cleanProfile(p) {
  const keys = ['lastName', 'firstName', 'phone', 'email', 'province', 'city', 'district', 'line1', 'line2', 'postcode', 'accountId', 'idSuffix'];
  const result = Object.fromEntries(keys.map(key => [key, String(p?.[key] || '').trim().slice(0, 300)]));
  if (result.idSuffix && !/^[\dXx]{4}$/.test(result.idSuffix)) throw new Error('证件字段只保存后四位，不保存完整证件号码');
  result.idSuffix = result.idSuffix.toUpperCase();
  return result;
}

export function loginURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.port && ['idmsa.apple.com.cn', 'idmsa.apple.com', 'appleid.apple.com', 'account.apple.com'].includes(u.hostname); }
  catch { return false; }
}

export function validateCheckoutProof(target, proof) {
  if (proof?.part_number !== target.part_number || Number(proof.quantity) !== target.quantity) throw new Error('购物袋 / 订单的 SKU 或数量与设置不符');
  const total = Number(proof.total), ceiling = target.price_cny * target.quantity;
  if (!(total > 0) || !Number.isFinite(total) || !(ceiling > 0) || Math.round(total * 100) > Math.round(ceiling * 100)) throw new Error('无法核对订单金额，或金额超出所选商品价格上限');
  return {part_number: target.part_number, quantity: target.quantity, total};
}
