import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeURL, validateTargets, validateSettings, parsePickup, cleanProfile, validateCheckoutProof, loginURL, effectiveScanInterval} from '../extension/core.js';

const target = {part_number: 'MK2N4CH/A', url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2n4ch/a', quantity: 2};
const store = (city, id, display, extra = {}) => ({city, storeNumber: id, storeName: city + '门店', partsAvailability: {'MK2N4CH/A': {pickupDisplay: display, storePickEligible: true, ...extra}}});

test('只有明确 available 且允许取货时才判定有货', () => {
  assert.equal(parsePickup({body: {stores: [store('厦门', 'R644', 'available')]}}, [target])[0].state, 'available');
  assert.equal(parsePickup({body: {stores: [store('厦门', 'R644', 'ineligible')]}}, [target])[0].state, 'unavailable');
  assert.equal(parsePickup({body: {stores: [store('厦门', 'R644', 'unknown')]}}, [target])[0].state, 'unknown');
  assert.equal(parsePickup({body: {stores: [store('厦门', 'R644', 'available', {storePickEligible: false})]}}, [target])[0].state, 'unknown');
});
test('福州有货不能触发厦门抢购，availableNow 不是商品库存', () => {
  const xiamen = {...store('厦门', 'R644', 'ineligible'), availableNow: true};
  const rows = parsePickup({body: {stores: [store('福州', 'R646', 'available'), xiamen]}}, [target]);
  assert.equal(rows[0].state, 'unavailable'); assert.equal(rows[0].stores.length, 1);
  assert.throws(() => parsePickup({body: {stores: [store('福州', 'R646', 'available')]}}, [target]));
});
test('异常和门店缺失不能伪装成无库存，未知结构不触发抢购', () => {
  assert.throws(() => parsePickup({body: {errorMessage: '地址无效'}}, [target]));
  assert.throws(() => parsePickup({body: {}}, [target]));
  assert.throws(() => parsePickup({head: {status: 500}, body: {stores: []}}, [target]));
  const s = store('厦门', 'R644', 'available'); s.partsAvailability = {};
  assert.equal(parsePickup({body: {stores: [s]}}, [target])[0].state, 'unknown');
});
test('SKU、数量、链接和地址限制', () => {
  assert.equal(validateTargets([target])[0].quantity, 2);
  for (const t of [{...target, quantity: 0}, {...target, quantity: 1.5}, {...target, url: 'https://evil.example/a'}, {...target, part_number: 'MK2M4CH/A'}]) assert.throws(() => validateTargets([t]));
  assert.throws(() => validateTargets([target, target]));
  const s = {mode: 'rush', strategy: 'first_available', interval: 5, postcode: '361000'};
  assert.equal(validateSettings(s).interval, 60);
  for (const interval of [1,3,10,30]) assert.equal(validateSettings({...s, interval}).interval, 60);
  assert.equal(validateSettings({...s, interval: 300}).interval, 300);
  assert.equal(validateSettings(s).fallbackDelivery, false);
  assert.equal(validateSettings({...s, fallbackDelivery: true}).fallbackDelivery, false);
  assert.equal(validateSettings({...s, fallbackDelivery: false}).fallbackDelivery, false);
  assert.throws(() => validateSettings({...s, postcode: '350000'}));
});
test('日常扫描最低一分钟，反复 541 降频，两小时无拒绝恢复基准', () => {
  const now=1e9;
  assert.equal(effectiveScanInterval({interval:10},null,now),60);
  assert.equal(effectiveScanInterval({interval:60},{strikes:2,lastAt:now},now),120);
  assert.equal(effectiveScanInterval({interval:60},{strikes:3,lastAt:now},now),300);
  assert.equal(effectiveScanInterval({interval:300},{strikes:2,lastAt:now},now),300);
  assert.equal(effectiveScanInterval({interval:60},{strikes:3,lastAt:now-7200000},now),60);
});
test('只信任官网 HTTPS 页面，个人信息中不保存密码', () => {
  assert(storeURL('https://secure7.www.apple.com.cn/shop/checkout'));
  assert(!storeURL('https://www.apple.com.cn.evil.example/shop/checkout'));
  assert(!storeURL('http://www.apple.com.cn/shop/checkout'));
  assert(!storeURL('https://untrusted.www.apple.com.cn/shop/checkout'));
  assert(!('password' in cleanProfile({firstName: '测试', password: 'fixture-only'})));
});
test('提交前独立核对 SKU、数量和金额上限', () => {
  const t = {...target, price_cny: 15999};
  const proof = {part_number: t.part_number, quantity: 2, total: 31998};
  assert.equal(validateCheckoutProof(t, proof).total, 31998);
  assert.throws(() => validateCheckoutProof(t, {...proof, quantity: 1}));
  assert.throws(() => validateCheckoutProof(t, {...proof, total: 32000}));
  assert.throws(() => validateCheckoutProof(t, {...proof, total: 0}));
});
test('分期方案只记录选定银行期数，证件只保存后四位，登录域名严格限定', () => {
  const settings = validateSettings({mode:'rush',strategy:'first_available',interval:30,postcode:'361000',payment:'installment_or_alipay',bank:'示例银行',periods:24});
  assert.equal(settings.bank, '示例银行'); assert.equal(settings.periods, 24);
  assert.throws(() => validateSettings({...settings, periods: 36}));
  assert.equal(cleanProfile({idSuffix:'123X'}).idSuffix, '123X');
  assert.throws(() => cleanProfile({idSuffix:'123456789012345678'}));
  assert(loginURL('https://idmsa.apple.com.cn/appleauth/auth/signin'));
  assert(!loginURL('https://idmsa.apple.com.cn.evil.example/signin'));
});
