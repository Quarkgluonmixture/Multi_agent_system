# iPhone Relay 配置与安全说明

iPhone Relay 是主扩展中的可选自动化：从 Telegram 接收一批图片，用 ChatGPT 网页生成答案，再回传 Telegram 和/或 WhatsApp。它不使用 OpenAI API，但会使用 Telegram Bot API，并要求 Chrome 中已登录 ChatGPT 和 WhatsApp Web。

```text
iPhone / Telegram client
        │ photos
        ▼
Telegram Bot API long polling
        │ authorized batch
        ▼
dedicated ChatGPT window
        │ answer text
        ├──► Telegram reply
        └──► WhatsApp Web send
```

## 前置条件

- 一个由 BotFather 创建的 Telegram bot token。
- 私聊模式：知道或首次自动绑定允许的 Telegram user ID。
- Shortcut/频道模式：bot 已加入目标频道或群组并能收到消息，且你知道其负数 chat ID。
- Chrome 已登录 ChatGPT。
- 若发往 WhatsApp：Chrome 已登录 WhatsApp Web，并准备好 E.164 格式号码，例如 `+447700900123`。

不要把真实 token、user ID、channel ID、手机号或包含这些值的 Debug bundle 提交到 Git。

## 打开配置面板

主聊天 `chat.html` 不展示 relay 设置。请通过 Chrome 的 Side Panel 入口打开本扩展的 `sidepanel.html`，展开“iPhone Relay · Telegram → ChatGPT → WhatsApp”。

字段说明：

| 字段 | 作用 |
|---|---|
| Bot token | 调用 Telegram Bot API；必填 |
| Allowed user ID | 私聊允许者；留空时第一位发图用户会被自动绑定 |
| Channel ID | 可信 chat/channel；配置后其中的消息不再按个人 sender 过滤 |
| Telegram | 把答案回到来源 chat |
| WhatsApp | 把答案发到指定号码 |
| WhatsApp # | 目标 E.164 号码；启用 WhatsApp 时必填 |
| Prompt | 随图片一起提交给 ChatGPT 的固定指令 |
| Enable poller | 开启/关闭 Telegram long poll |
| 保留 tab | 完成后保留 relay 创建的 ChatGPT/WhatsApp 页面，便于调试 |

填写后点击“保存并重启”。状态显示 running 才表示 poller 已启动。token 缺失或两个目的地都关闭时，relay 不会正常工作。

## 来源授权

### 私聊模式

填写 Allowed user ID 时，只接受该用户的消息。留空时，第一位给 bot 发送图片的私聊用户会被写入 `tgRelay.allowedUserId`，之后其他用户会被拒绝。

自动绑定方便但存在抢先绑定风险：在公开分享 bot username 前，先由你自己的账号发第一张图，随后确认界面中自动填入的 user ID。

### 可信频道/群组模式

配置 Channel ID 后，relay 接受该 chat 中的消息或频道 post，而不再校验具体 sender。这适合 iPhone Shortcut 经 bot/频道转发的流程，但意味着所有能向该 chat 发图的人都能触发 ChatGPT 和自动投递。只应填写成员和发言权限都受控的 chat。

## 图片 batching

- Telegram media group 使用 `media_group_id` 合并。
- iPhone Shortcut 逐张发送、没有 media group 的图片，会按来源 chat 聚合。
- 收到最后一张图片后等待约 6 秒再封包，因此正常会有短暂启动延迟。
- 每个 batch 记录来源、首条 message ID、caption、图片数组和排队时间。

caption 会附加给固定 prompt。图片通过 Bot API 下载为内存中的 base64，再交给 ChatGPT content adapter；仓库代码不会把图片写到工作区文件。

## 处理与重试

1. batch 先进入持久化的 in-flight 状态。
2. relay 创建独立、最大化的 ChatGPT 窗口并打开普通新对话。
3. `SUBMIT_WITH_ATTACHMENTS` 注入 prompt 和所有图片。
4. 轮询 ChatGPT，等待回答状态终止或正文 60 秒不再增长。
5. 检查空回答、短错误文案、多图低信息量和长时间“正在分析”等失败信号。
6. 缓存答案，再分别发送到启用的目的地。

ChatGPT batch 最多尝试 3 次，使用递增退避；单个投递目的地也有自己的重试。整个 batch 有 12 分钟硬超时，避免一个失去响应的 tab 永久占住队列。

service worker 重启后会把 in-flight batch 放回队首，并依靠 Telegram offset 与 processed 去重表避免重复消费。超过 30 分钟仍未处理的 queued batch 会在恢复时丢弃，避免第二天开机突然发送旧内容。

## 恢复按钮

- **重发上次答案**：使用 `lastAnswer` 缓存重新投递，不重新调用 ChatGPT。
- **清空队列**：删除 queued 和 in-flight 状态，并释放内存 busy 锁；无法恢复。
- **强制解锁**：清除 in-flight/busy，但保留 queued，随后立即尝试下一条。卡死时优先用它。

日志只保留当前 service worker 生命周期内最近一小段。需要排障时，在 worker 被回收前复制日志。

## Telegram 输出

长答案会按 Telegram 限制拆分。relay 会把常见 Markdown 转成 Telegram HTML，再通过 `sendMessage` 返回来源 chat。若格式转换或投递失败，日志会显示相应 Bot API 错误。

## WhatsApp 输出

relay 打开：

```text
https://web.whatsapp.com/send?phone=<digits>
```

`whatsapp_inject.js` 等待聊天输入框，插入答案，点击发送并以 composer 清空作为成功确认。号码无效、号码未注册、未登录、网页 selector 变化或发送后输入未清空都会返回不同错误。

浏览器扩展无法保证把 Chrome 抢到 Windows 最前台。专用窗口会请求 focused/maximized 并闪烁任务栏，但某些系统策略下仍需手动点开一次。

## 存储键

配置与恢复状态都在未加密的 `chrome.storage.local`：

```text
tgRelay.enabled
tgRelay.token
tgRelay.allowedUserId
tgRelay.allowedChannelId
tgRelay.prompt
tgRelay.waPhone
tgRelay.destTelegram
tgRelay.destWhatsapp
tgRelay.keepTabs
tgRelay.offset
tgRelay.queue
tgRelay.inFlight
tgRelay.processed
tgRelay.lastAnswer
```

任何能读取该 Chrome profile 或扩展本地存储的人，都可能取得 bot token、目的地和最近答案。不要在共享 profile 中启用 relay。

## 安全检查清单

- bot token 只保存在扩展设置中，不写入源码、截图、issue 或 commit。
- 私聊先手动完成自动绑定；频道只允许可信成员发言。
- WhatsApp 号码在第一次自动发送前人工核对。
- 用无敏感内容的一张测试图片验证 Telegram 与 WhatsApp 目的地。
- 关闭 relay 时取消勾选 Enable poller 并“保存并重启”。
- 账号异常、验证码或网页服务条款提示出现时停止自动化并人工处理。
- 不把学生隐私、未授权试卷或其他无权处理的图片交给外部 AI 服务。
