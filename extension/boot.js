/* 使用经典脚本检查入口，避免直接打开 HTML 时模块被浏览器拦截而静默失效。 */
(() => {
  const notice = document.getElementById('notice');
  const showError = message => {
    notice.textContent = message;
    notice.classList.add('error');
  };
  if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.runtime?.id) {
    showError('当前是普通网页 / 本地文件，尚未以浏览器扩展运行，所以不能读取官网型号。请按下面的步骤加载扩展。');
    for (const element of document.querySelectorAll('button,input,select')) element.disabled = true;
    const card = document.createElement('section');
    card.className = 'card';
    card.style.marginBottom = '20px';
    const heading = document.createElement('h2');
    heading.textContent = '先加载浏览器扩展';
    const steps = document.createElement('ol');
    for (const text of [
      '打开 Edge，地址栏输入 edge://extensions；Chrome 使用 chrome://extensions。',
      '打开“开发人员模式”，点击“加载解压缩的扩展”。',
      '选择下方目录，目录中应直接包含 manifest.json。',
      '点击工具栏的“抢看看”图标，从插件打开面板。请勿直接打开 panel.html。',
    ]) {
      const li = document.createElement('li'); li.textContent = text; li.style.margin = '12px 0'; steps.append(li);
    }
    const path = document.createElement('code');
    let folder = 'D:\\CodexProjects\\iphone-pickup-helper\\extension';
    if (location.protocol === 'file:') {
      folder = decodeURIComponent(new URL('.', location.href).pathname).replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\').replace(/\\$/, '');
    }
    path.textContent = folder;
    path.style.userSelect = 'all';
    const hint = document.createElement('p');
    hint.textContent = '本页仅展示安装提示；型号读取、库存查询和本地信息保存需要从插件入口使用。';
    hint.className = 'muted';
    card.append(heading, steps, path, hint);
    notice.after(card);
    return;
  }
  const initial = notice.textContent;
  document.getElementById('refresh').disabled = true;
  notice.textContent = '正在初始化插件……';
  import('./panel.js').then(() => {
    document.getElementById('refresh').disabled = false;
    if (notice.textContent === '正在初始化插件……') notice.textContent = initial;
  }).catch(() => {
    showError('插件面板初始化失败。请到浏览器扩展管理页点“重新加载”，再关闭并重新打开面板。此时没有执行库存监控或下单。');
  });
})();
