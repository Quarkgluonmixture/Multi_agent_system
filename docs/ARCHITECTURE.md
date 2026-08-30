# 架构说明

本文描述 Multi AI Chat v0.79 的实际运行结构。`docs/initial-thoughts.md` 是早期设计草稿，其中的 TypeScript 目录和逐 job 独立 tab 方案并不是当前实现。

## 运行拓扑

```text
Chrome action click
        │
        ▼
dedicated window: chat.html
  ├── chat UI + sidepanel.js
  ├── pipeline-animator.js
  └── hidden viewport grid
        ├── ChatGPT iframe ─┐
        ├── Gemini iframe ──┤ content_adapter.js
        ├── DeepSeek iframe ┤ registers frameId + drives page DOM
        └── Kimi iframe ────┘
                │
                ▼
background.js service worker
  ├── frame registry and readiness
  ├── R1/R2/Final orchestration
  ├── provider-specific prompt injection
  ├── retries, partial progress and debug state
  └── optional Telegram/WhatsApp relay
```

主聊天 tab 必须在自己的 Chrome 窗口中保持为该窗口的活动 tab。四个 iframe 位于正常视口坐标，聊天 UI 以不透明背景覆盖在其上方。这样既不直接展示 provider 页面，又尽量避免 `visibility:hidden`、透明度或移出视口导致的渲染/SSE 节流。

`grid.html` / `grid.js` 是兼容和调试入口。正常工作区由 `chat.html` 承担；`background.js` 在找不到聊天 tab 时才回退寻找旧 Grid。

## Pipeline 生命周期

### 1. UI 发起

`sidepanel.js` 从 `chrome.storage.local` 恢复对话、主题、参与者和主编，随后发送：

```js
{
  type: 'RUN_FULL_PIPELINE',
  prompt,
  history,
  providers,
  finalEditor
}
```

service worker 为本次运行创建 `AbortController`。新的 pipeline 会取消仍在内存中的旧 pipeline；UI 的停止按钮发送 `CANCEL_PIPELINE`。

### 2. 每个 stage 的三阶段调度

`runStage()` 对 R1、R2、Final 使用同一套调度：

1. **并行准备**：reload provider iframe，等待 content script 注册和输入框 ready。
2. **并行注入、串行发送**：ChatGPT/Gemini/Kimi 优先使用站点编辑器对象注入；随后依次点击发送，Gemini 排在最后并有额外 settle 时间。DeepSeek 走 content adapter 的编辑器路径。
3. **并行轮询**：所有已发送 provider 同时等待新 assistant 文本稳定。

串行的是短暂且依赖焦点的发送动作，不是模型生成本身。这样避免多个富文本 iframe 同时争抢焦点或触发 Gemini 事件队列竞争。

瞬时错误最多重跑一次当前 provider。每次重试会 reload iframe 并重新注入 prompt。成功或失败通过 `PROVIDER_UPDATE` 推送给 UI；Final 还携带 `partialOutput` 供流式渲染。

### 3. 降级条件

- R1 成功数少于 2：整轮失败。
- R1 至少 2 家成功：只有这些 provider 进入 R2。
- R2 成功数少于 2：不进入 Final。
- R2 至少 2 家成功：指定主编执行 Final。

这使单家网页临时故障不会直接拖垮完整协作，但扩展不会用一份孤立回答伪装成多模型共识。

## Prompt 与角色

`background.js` 中的构建函数负责边界明确的文本协议：

- `buildR1Prompt()`：独立结论、关键推理、盲点、不确定性、建议。
- `buildR2Prompt()`：注入原始问题、自己的 R1、其他 R1 和角色要求。
- `buildFinalPrompt()`：注入所有成功 R2 及角色标签，要求主编裁决而非平均摘要。

历史消息使用 `<conversation_history>` 包裹。R1/R2/Final 的模型输出使用 XML-ish 分隔，减少不同答案之间的边界混淆。

## Frame 注册与通信

manifest 将 `content_adapter.js` 注入四个 provider 域名的所有 frame。adapter 判断自身 provider 后发送 `CONTENT_SCRIPT_REGISTER`；service worker 维护：

```text
tabId -> provider -> frameId
```

之后的 `tabs.sendMessage` 都显式指定 `frameId`，避免同一 tab 的四个 content script 同时响应。主要消息包括：

| 消息 | 方向 | 用途 |
|---|---|---|
| `CONTENT_SCRIPT_REGISTER` | frame → SW | 注册 provider/frameId |
| `RUN_FULL_PIPELINE` | UI → SW | 启动完整 pipeline |
| `CANCEL_PIPELINE` | UI → SW | 中止当前 pipeline |
| `SUBMIT_AND_WAIT_START` | SW → frame | 校验/写入 prompt 并发送 |
| `PROVIDER_UPDATE` | SW → UI | 阶段状态与 Final partial |
| `COLLECT_DEBUG` | UI → SW | 收集运行诊断 |
| `FOCUS_IFRAME*` | SW → workspace | 在 fallback 输入前转移焦点 |

## 状态与持久化

### UI 状态

`sidepanel.js` 使用以下本地键：

| Key | 内容 |
|---|---|
| `conversation` | 用户/助手消息；助手消息内含 R1/R2 结果 |
| `theme` | light/dark |
| `enabledProviders` | 参与 R1/R2 的 provider |
| `finalEditor` | Final 主编 |

消息队列只存在页面内存中；关闭聊天页前尚未执行的 queued 消息不会恢复。

### Service worker 状态

frame map、当前 `AbortController` 和部分调度状态在内存中。debug 状态会节流写入存储，并能在 worker 重启后恢复部分诊断。provider iframe reload 后会重新注册，从而重建 frame map。

Relay 使用额外持久化队列、in-flight 记录、processed 去重表和 Telegram offset；细节见 [RELAY.md](RELAY.md)。

## 文件职责

| 文件 | 职责 |
|---|---|
| `manifest.json` | 权限、域名、background、side panel、DNR 与 content scripts |
| `background.js` | 顶层编排、window/frame 管理、prompt、重试、debug、relay delivery |
| `content_adapter.js` | provider 识别、DOM selector、输入/发送、开始/结束检测、回答抓取 |
| `chat.html` | 主工作区、聊天控件、四 iframe 容器 |
| `sidepanel.html` | 紧凑 UI；额外包含 relay 配置面板 |
| `sidepanel.js` | UI 状态、持久化、队列、渲染和 runtime 消息 |
| `pipeline-animator.js` | 三阶段可视化状态机 |
| `gemini-cloak.js` | Gemini 主世界 iframe 兼容处理 |
| `iframe_rules.json` | 调整允许 iframe 嵌入所需的响应头 |
| `telegram_relay.js` | Bot API long polling、来源过滤、图片 batching/downloading |
| `whatsapp_inject.js` | WhatsApp Web composer 注入、点击发送和发送确认 |

`ai-sidebar/` 拥有自己的 manifest、background、sidepanel 和 DNR 规则，是一个可单独加载的最小双站点浏览器，不参与上面的 frame 注册或 pipeline。

## 维护边界

- provider 网页变化应优先局限在 `content_adapter.js` 或对应编辑器注入函数。
- 调度和降级规则应留在 `background.js`，不要散落到 UI。
- UI 只消费结构化 runtime 消息，不直接操作 provider iframe DOM。
- 新增 provider 时必须同步更新 manifest 域名、chat/grid iframe、adapter 识别、`PROVIDERS`/`ALL_PROVIDERS`、UI 选择器、图标与 debug 输出。
- 修改结束判定时要覆盖普通流式模型和“思考后一次性出现正文”的 reasoning 模型。

## 验证层级

1. **静态**：所有 JavaScript 通过 `node --check`，JSON 可解析，manifest 引用的文件存在。
2. **加载**：Chrome 扩展页无 manifest/service worker 错误。
3. **注册**：Debug bundle 显示所选 provider 的 frameId 和 ready 探针。
4. **单轮**：至少两家完成 R1/R2，主编完成 Final，rounds 可展开。
5. **交互**：取消、消息排队、编辑/重跑、重新生成和本地恢复正常。
6. **回归**：四家全部启用跑一条短问题，并确认专用窗口在使用其他 Chrome 窗口时仍继续生成。
