/* 官网 DOM 驱动的自提结账。每次前进先写入任务状态；订单提交仅执行一次。 */
globalThis.IPhoneCheckout = (() => {
  const stable = new Map(), picked = new Map();
  const norm = value => String(value || '').replace(/\s+/g, '').toLowerCase();
  const rows = () => [...document.querySelectorAll('[data-autom^="bag-item-"]')].filter(e => /^bag-item-\d+$/.test(e.getAttribute('data-autom')));
  const button = autom => document.querySelector(`button[data-autom="${autom}"]`);
  const formField = name => document.querySelector(`input[data-autom="form-field-${name}"]`);
  function fulfillmentChoice(kind) {
    const labels = kind === 'pickup' ? ['我要取货'] : ['为我送货', '我要送货', '送货上门', '配送', 'Delivery', 'Ship it'];
    return [...document.querySelectorAll('button,[role="radio"],input[type="radio"]')].find(e => {
      const label = e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.textContent;
      return labels.some(text => norm(label) === norm(text));
    });
  }
  const selected = e => Boolean(e?.checked || ['aria-checked', 'aria-pressed', 'aria-selected'].some(key => e?.getAttribute(key) === 'true'));
  function money(text) {
    const match = String(text || '').match(/(?:RMB|CNY|人民币|[¥￥])\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    return match ? Number(match[1].replace(/,/g, '')) : NaN;
  }
  function sameItem(row, target) {
    const exact = [...row.querySelectorAll('a[href]')].some(a => {
      try { const u = new URL(a.href); return ['www.apple.com.cn', 'store.apple.com.cn'].includes(u.hostname) && decodeURIComponent(u.pathname).toUpperCase().endsWith('/' + target.part_number); }
      catch { return false; }
    });
    const title = row.querySelector('[data-autom="bag-item-name"],h2,h3');
    return exact || Boolean(title && norm(title.textContent).includes(norm(`${target.model} ${target.capacity} ${target.color}`)));
  }
  function quantity(row) {
    const select = row.querySelector('select[data-autom="item-quantity-dropdown"]');
    if (select) return Number(select.value);
    const explicit = row.querySelector('[data-autom="bag-item-quantity"], [data-autom="item-quantity"]');
    const match = (explicit?.textContent || row.innerText).match(/(?:数量\s*[:：]?\s*|Quantity\s*[:：]?\s*)(\d+)\b/i);
    return match ? Number(match[1]) : NaN;
  }
  function proof(task) {
    const items = rows();
    if (items.length !== 1 || !sameItem(items[0], task.target)) throw new Error('请核对购物袋：只能包含所选 SKU，已有其他商品时不会连带下单');
    const q = quantity(items[0]);
    if (q !== task.target.quantity) throw new Error('请核对商品数量：页面数量与设置不符');
    const total = money(document.querySelector('[data-autom="bagtotalvalue"]')?.textContent);
    if (!(total > 0) || Math.round(total * 100) > Math.round(task.target.price_cny * task.target.quantity * 100)) throw new Error('请核对订单金额：无法确认金额，或金额超过设置时的商品价格');
    return {part_number: task.target.part_number, quantity: q, total};
  }
  function isStable(key, signature, duration = 1500) {
    const prior = stable.get(key);
    if (!prior || prior.signature !== signature) { stable.set(key, {signature, at: Date.now()}); return false; }
    return Date.now() - prior.at >= duration;
  }
  function choose(key, element, visible) {
    if (!visible(element) || Date.now() - (picked.get(key) || 0) < 5000) return false;
    picked.set(key, Date.now()); element.click(); return true;
  }
  function orderNumber() {
    if (!/^\/shop\/(?:checkout(?:\/|$)|order\/(?:confirmation|confirm|thank))/i.test(location.pathname)) return '';
    const explicit = document.querySelector('[data-autom="order-number"], [data-autom="orderNumber"]');
    const text = document.body.innerText;
    const label = text.match(/(?:订单(?:号|编号)|Order\s*(?:number|#))\s*[:：#]?\s*(W\d{8,12})\b/i);
    const number = explicit?.textContent.match(/\bW\d{8,12}\b/)?.[0] || label?.[1];
    const review = Boolean(button('continue-button-placeOrder'));
    return number && !review && (explicit || /订单已|待付|感谢|确认订单|订单确认|Thank you|Order confirmation/i.test(text)) ? number.toUpperCase() : '';
  }
  async function handle(task, state, h) {
    const {ask, visible, setValue, status, fieldKey} = h;
    const update = (stage, note, extra = {}) => ask({type: 'taskUpdate', id: task.id, from: task.stage, stage, note, ...extra});
    const pause = async note => { await update('manual', note); status(note); };
    const fallback = async (reason, note) => {
      const next = await update('waiting_stock', note + '；已返回厦门自提库存扫描，不会切换配送', {reason});
      if (next.accepted) status('自提暂不可用，已恢复库存雷达；不会创建配送订单。');
    };
    const elapsed = Date.now() - (task.changedAt || task.startedAt);
    if (task.stage === 'manual') {
      const loginPause = task.pauseReason === 'login' || task.note?.startsWith('官网要求登录 / 验证');
      const step = new URLSearchParams(location.search).get('_s') || '';
      const pickup = fulfillmentChoice('pickup');
      if (loginPause && task.resumeStage === 'checkout' && /^\/shop\/checkout(?:\/|$)/.test(location.pathname) && /^Fulfillment(?:-|$)/i.test(step) && visible(pickup)) {
        await ask({type: 'resumeAfterLogin', id: task.id});
      }
      return;
    }
    if (['stopped', 'ordered', 'waiting_stock'].includes(task.stage)) return;
    if (['submitting', 'uncertain'].includes(task.stage)) {
      const number = orderNumber();
      if (number) {
        const changed = await update('ordered', `官网订单 ${number} 已生成，请在网页完成付款；库存保留以官网订单状态为准`, {orderNumber: number});
        if (changed.accepted) status(`官网订单 ${number} 已生成，请完成付款。`);
      } else if (task.stage === 'submitting' && Date.now() - task.submittedAt > 90000) {
        await update('uncertain', '已提交一次，但未确认订单号；请先查看官网订单列表，不会重试提交');
        status('提交结果待核实，请检查官网订单。');
      }
      return;
    }
    if (/signin/i.test(location.pathname) || /signin/i.test(new URLSearchParams(location.search).get('_s') || '')) {
      await pause('官网要求登录 / 验证，请使用快捷登录或在当前页完成验证，再点继续当前步骤'); return;
    }
    if (elapsed > 120000) { await pause('官网页面未能完成当前步骤，请检查页面后继续；尚未提交订单'); return; }
    const key = task.id + ':' + task.stage;

    if (task.stage === 'preflight') {
      if (!/^\/shop\/bag(\/|$)/.test(location.pathname)) return;
      const items = rows();
      if (items.length) {
        if (items.length !== 1 || !sameItem(items[0], task.target)) { await pause('原购物袋含其他商品，请本人处理后继续；插件不会删除商品或连带下单'); return; }
        await update('bag', '购物袋已包含目标 SKU，直接核对数量，避免重复添加'); return;
      }
      if (/你的购物袋是空的|您的购物袋是空的|(?:你的|您的)购物袋(?:中|里)没有(?:任何)?商品|购物袋为空|Your bag is empty/i.test(document.body.innerText)) {
        const next = await update('product', '原购物袋为空，正在打开目标 SKU');
        if (next.accepted) location.assign(task.target.url);
      } else if (elapsed > 30000) await pause('无法确认原购物袋是否为空，请打开购物袋检查后继续');
      return;
    }
    // 商品配置和加购物袋由 content.js 处理。
    if (['product', 'adding'].includes(task.stage)) return;
    if (task.stage === 'bag') {
      const items = rows();
      if (!items.length && elapsed < 30000) return;
      if (items.length !== 1 || !sameItem(items[0], task.target)) { await pause('请核对购物袋：商品与所选 SKU 不符，或出现其他商品'); return; }
      const select = items[0].querySelector('select[data-autom="item-quantity-dropdown"]');
      if (quantity(items[0]) !== task.target.quantity) {
        const option = select && [...select.options].find(o => !o.disabled && Number(o.value) === task.target.quantity);
        if (!option || !visible(select)) { await pause('官网无法购买所设数量，请核对数量；不会自动减少购买数量'); return; }
        if (Date.now() - (picked.get(key + ':quantity') || 0) >= 5000) { picked.set(key + ':quantity', Date.now()); setValue(select, option.value); }
        return;
      }
      const checkout = button('checkout');
      if (!visible(checkout)) return;
      let p;
      try { p = proof(task); } catch (error) { await pause(error.message); return; }
      if (!isStable(key, JSON.stringify(p))) return;
      const next = await update('checkout', '商品、数量和金额核对通过，正在进入自提结账', {proof: p});
      if (next.accepted) checkout.click();
      return;
    }
    if (task.stage === 'checkout') {
      if (button('fulfillment-continue-button') || document.querySelector('input[name="store-locator-result"]') || fulfillmentChoice('pickup')) {
        await update('fulfillment', '正在选择厦门自提门店和最早可用时段');
      } else if (formField('lastName') || button('continue-button-placeOrder')) {
        await pause('官网跳过了门店确认步骤，无法核实厦门自提，请本人检查');
      }
      return;
    }
    if (task.stage === 'fulfillment') {
      performance.setResourceTimingBufferSize(2000);
      const pickupTab = fulfillmentChoice('pickup');
      if (pickupTab && !selected(pickupTab)) { choose(key + ':pickup', pickupTab, visible); return; }
      const pickupClickedAt = picked.get(key + ':pickup');
      if (pickupClickedAt && !task.manualStepConfirmed) {
        const finished = performance.getEntriesByType('resource').some(e => e.name.includes('/checkoutx/fulfillment') && e.name.includes('_a=search') && performance.timeOrigin + e.startTime >= pickupClickedAt - 1000);
        if (!finished) {
          if (Date.now() - pickupClickedAt > 30000) await pause('未能确认官网门店查询已返回，请检查页面加载完成后点继续当前步骤');
          return;
        }
      }
      const stores = [...document.querySelectorAll('input[name="store-locator-result"]')];
      const store = stores.find(e => e.value === task.store.id);
      if (!store) {
        const more = button('show-more-stores-button');
        if (more && !picked.has(key + ':more')) choose(key + ':more', more, visible);
        else if (elapsed > 45000) await pause('结账页未找到所选厦门门店，无法确认查询结果，请核对取货地区后继续');
        return;
      }
      const explicitlyUnavailable = /不可取货|暂无|无货|unavailable|not available/i.test(store.labels?.[0]?.textContent || '');
      if (store.disabled || explicitlyUnavailable) {
        if (explicitlyUnavailable || isStable(key + ':store-unavailable', store.value, 5000)) await fallback('store_unavailable', '所选厦门门店在结账页不可取货');
        return;
      }
      stable.delete(key + ':store-unavailable');
      if (!store.checked) { choose(key + ':store', store, visible); return; }
      const dates = [...document.querySelectorAll('input[name="bartPickupDateSelectorButtonGroup"]')];
      const selectedDate = dates.find(e => e.checked && !e.disabled);
      const firstDate = dates.find(e => !e.disabled && !picked.has(key + ':empty-date:' + e.value));
      if (firstDate) stable.delete(key + ':no-dates');
      if (dates.length && (!selectedDate || selectedDate !== firstDate)) {
        if (firstDate) choose(key + ':date', firstDate, visible);
        else if (isStable(key + ':no-dates', dates.map(e => e.value).join(','), 5000)) await fallback('no_dates', '没有可用的自提日期');
        return;
      }
      const slot = document.querySelector('select[data-autom="pickup-availablewindow-dropdown"]');
      if (slot) {
        const first = [...slot.options].find(o => o.value && !o.disabled);
        if (!first) {
          if (isStable(key + ':no-slots', selectedDate?.value || 'default', 5000)) {
            if (selectedDate) picked.set(key + ':empty-date:' + selectedDate.value, Date.now());
            else await fallback('no_slots', '没有可用取货时段');
          }
          return;
        }
        stable.delete(key + ':no-slots');
        if (slot.value !== first.value) { if (visible(slot)) setValue(slot, first.value); return; }
      }
      const nextButton = button('fulfillment-continue-button');
      if (!visible(nextButton)) return;
      const pickup = {storeId: store.value, date: selectedDate?.value || '', slot: slot?.value || ''};
      if (!isStable(key, JSON.stringify(pickup))) return;
      const next = await update('contact', '厦门门店和取货时段已确认，正在核对取货人', {pickup});
      if (next.accepted) nextButton.click();
      return;
    }
    if (task.stage === 'delivery') {
      const tab = fulfillmentChoice('delivery');
      if (!tab) { if (elapsed > 15000) await pause('未找到官网配送选项，请在当前页面检查配送库存后继续'); return; }
      if (tab.disabled) { await pause('官网配送也不可用，请保留购物袋并检查发售 / 库存状态'); return; }
      if (!selected(tab)) { choose(key + ':delivery', tab, visible); return; }
      const nextButton = button('fulfillment-continue-button');
      if (!visible(nextButton) || !isStable(key, 'delivery')) return;
      const next = await update('shipping', '官网配送方式已选择，正在核对收货地址', {deliverySelected: true});
      if (next.accepted) nextButton.click();
      return;
    }
    if (task.stage === 'shipping') {
      const required = ['lastName', 'firstName', 'phone', 'email', 'province', 'city', 'district', 'line1', 'postcode'];
      const profile = state.profile || {};
      if (required.some(k => !profile[k])) { await pause('配送资料不完整，请保存姓名、电话、邮箱、省市区、街道和邮编后继续'); return; }
      const inputs = [...document.querySelectorAll('input,textarea,select')].filter(visible);
      const address = {};
      for (const k of [...required, 'line2']) {
        const field = inputs.find(e => fieldKey(e) === k);
        if (k === 'line2' && !profile[k] && !field) { address[k] = ''; continue; }
        if (!field) { if (elapsed > 15000) await pause('无法核对完整配送地址字段，请检查官网页面后继续'); return; }
        const value = field instanceof HTMLSelectElement ? field.selectedOptions[0]?.textContent.trim() : field.value.trim();
        if (!field.checkValidity() || norm(value) !== norm(profile[k])) { await pause('页面收货地址与保存资料不符或校验未通过，请核对后继续'); return; }
        address[k] = profile[k] || '';
      }
      const errors = [...document.querySelectorAll('[role="alert"], .rs-form-error, .rs-error-message')].filter(visible);
      if (errors.some(e => e.textContent.trim())) { await pause('官网提示收货地址错误，请检查后继续'); return; }
      const nextButton = button('continue-button-label');
      if (!visible(nextButton) || !isStable(key, JSON.stringify(address))) return;
      const next = await update('billing', '配送地址核对通过，正在选择付款方式；不会支付', {profileRevision: state.profileRevision, address});
      if (next.accepted) nextButton.click();
      return;
    }
    if (task.stage === 'contact') {
      const names = ['lastName', 'firstName', 'fullDaytimePhone', 'emailAddress'];
      const fields = names.map(formField);
      if (fields.some(e => !e)) return;
      if (fields.some(e => !e.value.trim() || !e.checkValidity())) { await pause('取货人姓名、电话或邮箱不完整，请填好后点继续当前步骤'); return; }
      const keys = ['lastName', 'firstName', 'phone', 'email'];
      if (fields.some((e, i) => state.profile?.[keys[i]] && norm(e.value) !== norm(state.profile[keys[i]]))) { await pause('页面取货人信息与保存资料不同，请核对并更新页面或本地资料后继续'); return; }
      const identity = formField('nationalIdSelf');
      if (identity && !identity.value.trim()) {
        const label = identity.labels?.[0]?.textContent || '';
        if (state.profile?.idSuffix && (identity.maxLength === 4 || /后[四4]位|last\s*4/i.test(label)) && visible(identity)) setValue(identity, state.profile.idSuffix);
        else { await pause('官网要求填写取货证件信息，请在本地设置保存后四位或在页面填写，再继续'); return; }
      }
      if (identity && !identity.checkValidity()) { await pause('官网证件信息校验未通过，请在页面检查'); return; }
      const errors = [...document.querySelectorAll('[role="alert"], .rs-form-error, .rs-error-message')].filter(visible);
      if (errors.some(e => e.textContent.trim())) { await pause('官网提示取货信息错误，请检查后继续'); return; }
      const nextButton = button('continue-button-label');
      if (!visible(nextButton)) return;
      const next = await update('billing', '取货信息核对通过，正在选择付款方式；不会支付', {profileRevision: state.profileRevision});
      if (next.accepted) nextButton.click();
      return;
    }
    if (task.stage === 'billing') {
      const choices = [...document.querySelectorAll('input[data-autom^="checkout-billingOptions-"]')];
      if (!choices.length) return;
      const plan = task.plan || {payment: 'alipay'};
      const labelText = e => (e.labels?.[0]?.textContent || '') + ' ' + [...(e.labels?.[0]?.querySelectorAll('img') || [])].map(i => i.alt).join(' ');
      const installment = plan.payment === 'installment_or_alipay' && plan.bank ? choices.find(e => /^installments/i.test(e.value) && norm(labelText(e)).includes(norm(plan.bank))) : null;
      let payment = {method: plan.payment === 'wechat' ? 'WECHAT' : 'ALIPAY', bank: '', periods: 0, zeroFee: false};
      let choice = choices.find(e => e.value === payment.method);
      if (installment && !picked.has(key + ':installmentUnavailable') && !installment.disabled && /免息|0\s*[%％].*(费率|利率)|(?:费率|利率).*0\s*[%％]/.test(labelText(installment))) {
        if (!installment.checked) { choose(key + ':bank', installment, visible); return; }
        const prefix = installment.value + '-';
        const periods = [...document.querySelectorAll('input[type="radio"]')].filter(e => (e.getAttribute('data-autom') || '').startsWith(prefix));
        const period = periods.find(e => e.getAttribute('data-autom') === prefix + String(plan.periods));
        if (!periods.length && elapsed < 30000) return;
        if (period && !period.disabled) {
          if (!period.checked) { choose(key + ':period', period, visible); return; }
          choice = installment; payment = {method: 'INSTALLMENT', bank: plan.bank, periods: plan.periods, zeroFee: true};
        } else picked.set(key + ':installmentUnavailable', Date.now());
      }
      if (!choice || choice.disabled) { await pause('官网不支持所选付款方式，请在页面核对；不会自动选择其他收费方案'); return; }
      if (!choice.checked) { choose(key + ':payment', choice, visible); return; }
      const nextButton = button('continue-button-review');
      if (!visible(nextButton) || !isStable(key, JSON.stringify(payment))) return;
      const next = await update('review', payment.method === 'INSTALLMENT' ? `已选择 ${plan.bank} ${plan.periods} 期免息分期，正在复核订单` : `已选择 ${payment.method === 'ALIPAY' ? '支付宝' : '微信'}，正在复核订单`, {payment});
      if (next.accepted) nextButton.click();
      return;
    }
    if (task.stage === 'review') {
      const submit = button('continue-button-placeOrder');
      if (!visible(submit)) return;
      let p;
      try { p = proof(task); } catch (error) { await pause(error.message); return; }
      const fulfillmentVerified = task.fulfillmentMode !== 'delivery' && task.pickup && task.pickup.storeId === task.store.id && task.pickup.date && task.pickup.slot;
      if (!fulfillmentVerified || !task.contactVerified || !task.payment) { await pause('取货方式、联系人或付款方式的确认记录不完整，暂停提交'); return; }
      const storeName = String(task.store.name || '').replace(/Apple|厦门市?|\s/gi, '');
      const summary = [...document.querySelectorAll('[data-autom*="fulfillment" i],[data-autom*="pickup" i],[data-autom*="review" i],section')].find(e => visible(e) && storeName && norm(e.innerText).includes(norm(storeName)) && /取货|自提|pickup/i.test(e.innerText));
      if (!summary) { await pause('订单复核页未能确认所选厦门门店的自提信息，不会提交配送或未知取货方式的订单'); return; }
      if (task.contactRevision !== state.profileRevision) { await pause('联系人资料已修改，请重新核对并从购物袋重新开始；尚未提交订单'); return; }
      if (!isStable(key, JSON.stringify(p))) return;
      if (task.testOnly !== false) { await pause('测试已到订单复核页：取货门店、时段、联系人和付款方式已核对，未提交订单'); return; }
      const next = await update('submitting', '订单复核通过，正在提交一次；等待官网订单号，不会重复提交', {proof: p, pickupProof: {storeId: task.store.id}});
      if (next.accepted) { submit.click(); status('已执行一次订单提交，等待官网确认；请准备本人付款。'); }
    }
  }
  return {handle};
})();
