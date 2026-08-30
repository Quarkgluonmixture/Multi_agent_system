# Multi AI Chat

> 像唐代三省六部：多家 AI 先独立草拟，再带着不同审议角色交叉修订，最后由指定主编合成答案。

Multi AI Chat 是一个 Chrome Manifest V3 扩展。它不调用模型 API，而是驱动你已经登录的 ChatGPT、Gemini、DeepSeek 和 Kimi 网页，把一次提问自动编排成三阶段协作：

1. **R1 独立回答**：所有参与者在看不到其他回答的情况下分别分析。
2. **R2 交叉评审**：幸存的参与者读取 R1 输出，并按各自的审议角色修订答案。
3. **Final 主编合成**：指定模型整合 R2，保留共识、裁决分歧并给出可执行方案。

当前扩展版本：**v0.79**。

## 功能概览

- ChatGPT / Gemini / DeepSeek / Kimi 任意组合参与，至少启用两家。
- 主编可单独指定，默认 Gemini，也可以不在 R1/R2 参与者中。
- 四个网页 AI 作为 iframe 嵌入同一个专用聊天窗口，生成阶段并行运行。
- 输入注入并行准备、发送动作串行执行、结果并行轮询，兼顾速度与网页编辑器稳定性。
- 单模型瞬时失败自动重试一次；R1/R2 只要至少两家成功就可继续。
- Final 输出实时显示；完整 R1/R2 可展开查看。
- 支持多轮上下文、消息排队、编辑后重跑、重新生成、取消、深浅主题和本地持久化。
- 一键复制 debug bundle；可临时显示底层 Grid 排查网页选择器问题。
- 可选 iPhone Relay：Telegram 收图 → ChatGPT 解题 → 回传 Telegram 和/或 WhatsApp。
- 附带独立的 `ai-sidebar/` 小扩展，仅用于在 ChatGPT 与 Gemini 网页间切换，不参与多模型 pipeline。

## 安装

1. 克隆仓库：

   ```powershell
   git clone git@github.com:Quarkgluonmixture/Multi_agent_system.git
   ```

2. Chrome 打开 `chrome://extensions`，启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择仓库根目录。
4. 分别登录以下站点：
   - <https://chatgpt.com>
   - <https://gemini.google.com>
   - <https://chat.deepseek.com>
   - <https://www.kimi.com>
5. 点击扩展图标。扩展会打开或聚焦一个最大化的专用聊天窗口。

无需 npm、构建步骤或 API key。修改源码后，在 `chrome://extensions` 中点击扩展的“重新加载”。

## 使用

1. 在“参与协作”中保留至少两家模型。
2. 在“主编合成”中选择最终编辑者。
3. 输入问题，按 Enter 或点击“发送”；Shift+Enter 换行。
4. 等待 R1 → R2 → Final 完成。运行中仍可继续输入，新消息会进入队列。
5. 点击最终回答中的“查看推理过程”展开各家 R1/R2 原文。

顶部工具：

- **全屏**：切换聊天窗口全屏。
- **看 Grid**：显示或隐藏四个真实 AI iframe，仅用于调试或手动处理登录状态。
- **清 Gemini**：打开 Gemini 并批量删除它找到的对话历史。这是破坏性操作，使用前请确认确实要删除。
- **新对话**：清空扩展本地保存的当前对话。
- **Debug**：复制运行状态、frame 注册、探针和错误记录。

更完整的操作与故障排查见 [使用指南](docs/USER_GUIDE.md)。

## 支持范围

| Provider | 起始页面 | 会话方式 | 备注 |
|---|---|---|---|
| ChatGPT | `chatgpt.com/?temporary-chat=true` | pipeline 使用临时对话 URL | relay 使用普通新对话，可能留下历史 |
| Gemini | `gemini.google.com/app` | iframe 内普通会话 | 可用“清 Gemini”批量清理历史 |
| DeepSeek | `chat.deepseek.com` | 普通会话 | 无原生临时对话 |
| Kimi | `www.kimi.com` | 普通会话 | 使用 Lexical 编辑器注入路径 |

网页 DOM、登录流程、验证码或服务商策略变化都可能使某个 adapter 暂时失效。项目不会绕过验证码、限流或反自动化措施。

## 架构

```text
chat.html + sidepanel.js
        │ RUN_FULL_PIPELINE / CANCEL_PIPELINE
        ▼
background.js (MV3 service worker)
        │ reload + inject + submit + poll
        ▼
4 embedded provider iframes
        │ content_adapter.js
        ▼
ChatGPT / Gemini / DeepSeek / Kimi Web UI
```

主聊天页与四个 iframe 放在同一个专用 Chrome 窗口。iframe 位于正常视口坐标并被不透明聊天 UI 遮住，以减少后台标签页对渲染和流式响应的节流。详细设计、消息协议和文件职责见 [架构说明](docs/ARCHITECTURE.md)。

## iPhone Relay（可选）

Relay 会把授权 Telegram 用户或可信频道发来的图片分组下载，交给专用 ChatGPT 会话处理，再把答案发回 Telegram 和/或指定 WhatsApp 号码。配置入口在 Chrome 的扩展 Side Panel 中，不在主聊天窗口里。

它会保存 bot token、队列和最近一次答案到未加密的 `chrome.storage.local`，并能自动向外发送消息。启用前请阅读 [Relay 配置与安全说明](docs/RELAY.md)。仓库源码中不应提交真实 token、用户 ID 或电话号码。

## 仓库结构

```text
manifest.json             Chrome MV3 声明、权限与 content scripts
background.js             pipeline、iframe 管理、重试、debug、relay 编排
content_adapter.js        四家网页的输入、发送、生成状态和回答抓取适配
chat.html                 专用聊天窗口与内嵌四 iframe 工作区
sidepanel.html/.js        共用聊天逻辑；Side Panel 额外提供 relay 设置
pipeline-animator.js      R1/R2/Final 进度动画
gemini-cloak.js           Gemini iframe 环境兼容处理
telegram_relay.js         Telegram long polling、鉴权、图片分组与下载
whatsapp_inject.js        WhatsApp Web 文本注入、发送与结果确认
iframe_rules.json         移除阻止 provider iframe 的响应头规则
grid.html/.js             兼容/调试用的旧 Grid 入口
ai-sidebar/               独立的双站点侧栏扩展，不是主扩展依赖
docs/                     使用、架构、relay 和历史设计文档
```

## 数据、权限与风险

- 对话、主题、provider 选择、debug 状态及 relay 配置保存在本机 Chrome profile 的 `chrome.storage.local`，没有加密。
- 扩展需要 `tabs`、`scripting`、`storage`、`declarativeNetRequest`、`sidePanel` 和 `alarms` 权限，并可访问列出的 AI、Telegram API 与 WhatsApp Web 域名。
- 一次四模型完整运行最多产生 4 + 4 + 1 次网页模型请求；账号消息额度可能很快消耗。
- 网页 UI 自动化可能受各服务条款限制，请只在你有权使用的账号和内容上运行。
- `iframe_rules.json` 会调整目标站点的 frame 相关响应头，仅作用于 manifest 声明的规则和域名。

## 文档

- [使用指南](docs/USER_GUIDE.md)
- [架构说明](docs/ARCHITECTURE.md)
- [iPhone Relay](docs/RELAY.md)
- [优化 backlog](docs/OPTIMIZATIONS.md)
- [初始设计草稿](docs/initial-thoughts.md)

## 开发与验证

本项目是无构建步骤的原生 JavaScript 扩展。提交前至少运行：

```powershell
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-Content manifest.json | ConvertFrom-Json | Out-Null
Get-Content iframe_rules.json | ConvertFrom-Json | Out-Null
```

静态检查不能验证网页 selector。涉及 provider adapter 的改动仍需在已登录的 Chrome 中至少跑一次真实 pipeline，并用 Debug bundle 核对 frame、提交和抓取阶段。

## License

仓库当前尚未包含独立的 `LICENSE` 文件；分发或复用前请先补充明确许可证。
