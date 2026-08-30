# WhatsApp One-shot Sender

`Multi_agent_system` 现在除了 iPhone Relay 内部的 WhatsApp delivery 外，还提供一个通用的单次文本发送入口。

## 用途

适合由其他个人工作流先准备好一条非批量消息，再通过当前 Chrome 已登录的 WhatsApp Web 发给指定 E.164 号码，例如：

- 住宿 / 服务商询价；
- 已经人工确认过目标号码的 follow-up；
- 需要保留现有 WhatsApp 登录态、但不值得单独接 Business API 的低频 outbound。

它不是群发器，也不会自动遍历联系人。

## 打开

加载 / 重新加载扩展后：

1. 打开 `chrome://extensions`；
2. 找到 Multi AI Chat；
3. 点击“详细信息”；
4. 点击“扩展程序选项”（Extension options）。

会打开 `whatsapp_send.html`。

## 输入

- **目标号码**：建议 E.164，例如 `+447700900123`；内部会去掉空格、括号和连字符，最终要求 7–15 位数字。
- **消息正文**：不能为空，硬上限 20,000 字符。
- **发送成功后保留窗口**：默认关闭。失败时窗口始终保留，便于检查登录态、号码和 WhatsApp Web selector。

点击“发送 WhatsApp”后，扩展会：

1. 打开 `https://web.whatsapp.com/send?phone=<digits>`；
2. 等待 tab complete；
3. 复用现有 `whatsapp_inject.js`；
4. 向 WhatsApp composer 注入文本并点击发送；
5. 以 composer 清空作为成功确认；
6. 成功且未选择保留窗口时关闭临时 WhatsApp window。

## Runtime primitive

扩展内部页面也可以直接调用：

```js
const result = await chrome.runtime.sendMessage({
  type: 'WHATSAPP_SEND_ONCE',
  phone: '+447700900123',
  text: 'Hello',
  keepTab: false
});
```

返回示例：

```js
{ ok: true, phone: '+447700900123', tabId: 123 }
```

失败时：

```js
{ ok: false, error: '...', phone: '+447700900123', tabId: 123 }
```

## 边界

- 只接受本扩展内部发起的 runtime message。
- 同一时刻只允许一个 one-shot send，避免多个 WhatsApp window 争用。
- 不在源码或默认配置中保存目标手机号或消息正文。
- 不绕过 WhatsApp 登录、验证码、账号限制或服务条款提示。
- 任何 booking、付款、押金、合同等行为仍应由上层工作流单独控制；本 primitive 只负责发送给定文本。
