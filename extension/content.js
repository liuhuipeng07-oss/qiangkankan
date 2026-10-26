(() => {
  'use strict';
  if (!(['www.apple.com.cn', 'store.apple.com.cn'].includes(location.hostname) || /^secure\d*\.(www|store)\.apple\.com\.cn$/.test(location.hostname))) return;
  let working = false;
  let productSeen = Date.now();
  let banner;
  const visible = e => Boolean(e && e.getClientRects().length && !e.disabled && !e.readOnly);
  const ask = async message => {
    const r = await chrome.runtime.sendMessage(message);
    if (!r?.ok) throw new Error(r?.error || '插件暂时不可用');
    return r.data;
  };
  function status(text) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'iphone-helper-status';
      Object.assign(banner.style, {position: 'fixed', right: '18px', bottom: '18px', maxWidth: '350px', padding: '15px 18px', color: '#fff', background: '#166653', borderRadius: '12px', boxShadow: '0 8px 30px #0003', zIndex: '2147483647', font: '14px/1.6 system-ui'});
      document.body.append(banner);
    }
    banner.textContent = 'iPhone 助手 · ' + text;
  }
  function setValue(field, value) {
    const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', {bubbles: true}));
    field.dispatchEvent(new Event('change', {bubbles: true}));
  }
  const mapping = {
    lastName: ['family-name', ['lastname', 'familyname']], firstName: ['given-name', ['firstname', 'givenname']],
    phone: ['tel', ['phone', 'phonenumber', 'mobilephone', 'daytimephone']], email: ['email', ['email', 'emailaddress']],
    province: ['address-level1', ['province', 'state', 'stateprovince']], city: ['address-level2', ['city']],
    district: ['address-level3', ['district', 'county']], line1: ['address-line1', ['street', 'street1', 'address1', 'addressline1']],
    line2: ['address-line2', ['street2', 'address2', 'addressline2']], postcode: ['postal-code', ['postalcode', 'postcode', 'zipcode']],
  };
  function fieldKey(field) {
    if (field.closest('[data-autom*="billing" i], [id*="billing" i], [name*="billing" i]')) return null;
    const tokens = (field.autocomplete || '').toLowerCase().split(/\s+/);
    const attrs = [field.id, field.name, field.getAttribute('data-autom') || ''].map(s => String(s || '').toLowerCase());
    if (tokens.includes('billing') || attrs.some(s => s.includes('billing'))) return null;
    const pickupFields = {'form-field-lastName': 'lastName', 'form-field-firstName': 'firstName', 'form-field-emailAddress': 'email', 'form-field-fullDaytimePhone': 'phone'};
    const pickupKey = pickupFields[field.getAttribute('data-autom')];
    if (pickupKey) return pickupKey;
    const shippingFields = {'form-field-street': 'line1', 'form-field-street2': 'line2', 'form-field-city': 'city', 'form-field-state': 'province', 'form-field-district': 'district', 'form-field-postalCode': 'postcode'};
    if (shippingFields[field.getAttribute('data-autom')]) return shippingFields[field.getAttribute('data-autom')];
    for (const [key, [token, suffixes]] of Object.entries(mapping)) {
      if (tokens.includes(token) || key === 'line1' && tokens.includes('street-address') || key === 'phone' && tokens.includes('tel-national')) return key;
      for (const attr of attrs) {
        const compact = attr.replace(/[^a-z0-9]/g, '');
        for (const prefix of ['shippingaddress', 'pickupcontact', 'pickup', 'shippingcontact', 'contact']) {
          if (compact.startsWith(prefix) && suffixes.includes(compact.slice(prefix.length))) return key;
        }
      }
    }
    return null;
  }
  function fillProfile(profile) {
    if (!profile || !/^\/shop\/(checkout|account)(\/|$)/.test(location.pathname)) return;
    let count = 0;
    for (const field of document.querySelectorAll('input:not([type=password]):not([type=hidden]),textarea,select')) {
      if (!visible(field)) continue;
      const key = fieldKey(field), value = profile[key];
      if (!key || !value) continue;
      if (field instanceof HTMLSelectElement) {
        const selected = field.selectedOptions[0];
        if (field.value && !/选择|select|choose/i.test(selected?.textContent || '')) continue;
        const option = [...field.options].find(o => o.textContent.trim() === value);
        if (option) { setValue(field, option.value); count++; }
      } else if (!field.value && !['checkbox', 'radio', 'button', 'submit'].includes(field.type)) {
        setValue(field, value); count++;
      }
    }
    if (count) status('已填入空白联系人 / 地址字段，请核对；尚未提交订单。');
  }
  async function update(task, stage, note) {
    return ask({type: 'taskUpdate', id: task.id, from: task.stage, stage, note});
  }
  async function rush(task) {
    if (!task || ['stopped', 'manual'].includes(task.stage)) return;
    if (task.stage === 'product') {
      const expected = new URL(task.target.url);
      if (location.pathname !== expected.pathname || location.hostname !== expected.hostname) return;
      // 明确选择不折抵、不加购 AppleCare，不增添额外付费服务。
      for (const selector of ['[data-autom="choose-noTradeIn"]', '[data-autom="noapplecare"]']) {
        const option = document.querySelector(selector);
        if (visible(option) && !option.checked) { option.click(); return; }
      }
      const button = document.querySelector('[data-autom="add-to-cart"]');
      if (visible(button)) {
        const claimed = await update(task, 'adding', '正在尝试加入购物袋；尚未锁单');
        if (claimed.accepted) { button.click(); status('正在加入购物袋。'); }
      } else if (Date.now() - productSeen > 30000) {
        await update(task, 'manual', '未找到可用的加入购物袋按钮，请检查预购状态、商品配置或网站验证');
        status('官网尚不能自动加入购物袋，请检查页面。');
      }
    } else if (task.stage === 'adding') {
      const heading = document.querySelector('h1')?.textContent || '';
      if (/Page Not Found/i.test(document.title) || /页面.*(?:不存在|找不到)|The page.*can.t be.*found/i.test(heading)) {
        const responseStatus = Number(performance.getEntriesByType('navigation')[0]?.responseStatus) || 0;
        const note = `官网加袋返回${responseStatus ? ' HTTP ' + responseStatus : '错误页'}，尚未确认加入购物袋；请检查官网购物袋或验证提示，再继续。不会重复添加`;
        await update(task, 'manual', note); status(note); return;
      }
      if (/^\/shop\/bag(\/|$)/.test(location.pathname)) {
        await update(task, 'bag', '已到购物袋，需核对 SKU 和数量后结账；尚未锁单');
      } else {
        const review = document.querySelector('[data-autom="reviewBagLink"], [data-autom="review-bag"], [data-autom="proceed"]');
        if (visible(review) && /查看购物袋|Review Bag/i.test(review.textContent)) { review.click(); return; }
        if (Date.now() - task.startedAt > 45000) {
          await update(task, 'manual', '加购物袋后的页面需要人工检查，请勿重复添加；尚未确认数量或锁单');
          status('请查看购物袋并核对商品和数量。');
        }
      }
    }
  }
  async function tick() {
    if (working || !chrome.runtime?.id) return;
    working = true;
    try {
      const state = await ask({type: 'contentState'});
      if (Number(performance.getEntriesByType('navigation')[0]?.responseStatus) === 503) {
        const note = '官网正在维护或暂时不可用（HTTP 503），已暂停购买步骤；恢复后刷新页面，再继续当前步骤';
        if (state.task && !['manual', 'stopped', 'ordered', 'submitting', 'uncertain'].includes(state.task.stage)) await update(state.task, 'manual', note);
        status(note);
        return;
      }
      if (state.autofill) fillProfile(state.profile);
      await rush(state.task);
      if (state.task) await globalThis.IPhoneCheckout.handle(state.task, state, {ask, visible, setValue, status, fieldKey});
    } catch { /* 不输出个人信息；扩展重载后刷新页面即可重新连接。 */ }
    finally { working = false; }
  }
  tick();
  setInterval(tick, 750);
})();
