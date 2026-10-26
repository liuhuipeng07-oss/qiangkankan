/* 仅在用户主动快捷登录的标签页填写账号；密码只使用浏览器已有填写。 */
(() => {
  const stages = new Set();
  let busy = false;
  const visible = e => Boolean(e && e.getClientRects().length && !e.disabled);
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({type: 'loginProfile'});
      const account = response?.ok && response.data?.accountId;
      if (!account) return;
      const username = document.querySelector('#account_name_text_field');
      if (!username) return;
      if (!username.value && visible(username)) {
        username.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(username, account);
        username.dispatchEvent(new Event('input', {bubbles: true})); username.dispatchEvent(new Event('change', {bubbles: true})); username.blur();
      }
      if (username.value.trim().toLowerCase() !== account.toLowerCase()) return;
      const password = document.querySelector('#password_text_field'), button = document.querySelector('#sign-in');
      if (!visible(button)) return;
      const stage = visible(password) ? 'password' : 'account';
      if (stages.has(stage)) return;
      // 仅判断密码管理器是否已经填写，不传输或持久化密码内容。
      if (stage === 'password' && !password.value) return;
      stages.add(stage); button.click();
    } catch { /* 验证和设备确认由本人处理，不自动重试密码提交。 */ }
    finally { busy = false; }
  }
  tick(); setInterval(tick, 1000);
})();
