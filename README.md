# 抢看看

用于 Apple 中国官网的厦门自提库存监控与辅助结账浏览器扩展。当前版本 **0.3.6**，Chrome / Edge Manifest V3。

## 功能

- 从官网读取型号和配置，按优先级监控多个 SKU。
- 60 / 120 / 300 秒扫描；查询失败显示未知，541 持久化退避。
- 仅厦门自提；核对商品、数量、金额、门店和时段后提交一次。
- 确认官网订单号后提醒本人付款；提交结果不明不自动重试。
- 本机保存联系人资料，启动前检查完整性，后台检测结算超时。
- 桌面提醒测试与失败状态。当前没有手机推送。

## 安装

在浏览器扩展管理页打开开发者模式，选择“加载已解压的扩展程序”，选中本仓库的 `extension` 文件夹。已有安装请更新原目录并重新加载，避免卸载造成资料丢失。

详见 [插件安装说明](插件安装说明.md)、[自动锁单使用说明](自动锁单使用说明.md)和[购买流程](购买流程.md)。

## 使用边界

浏览器关闭或电脑休眠时不能扫描。登录验证码、设备确认及付款由本人完成。本机模拟测试通过不代表真实官网每个版本均可锁单；库存保留及支付期限以官网订单状态为准。非 Apple 官方产品，不保证购买成功。

账号和联系人保存在浏览器本机存储，密码及验证码不由扩展保存。不要将 `.env`、个人资料、浏览器配置、会话或日志提交到仓库。

## 本地验证

需要 Node.js、Python 和已安装的 Microsoft Edge；Python 测试依赖 Playwright。

```powershell
python -m pip install -r requirements-dev.txt
node --test extension-tests/core.mjs
python extension-tests/verify_reliability.py
python extension-tests/verify_checkout.py --cases radar login_resume timeout
```

上述测试使用隔离浏览器及模拟响应，不提交真实订单。
