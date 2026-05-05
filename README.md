# Multi AI Chat

> 像唐代三省六部：三家 AI **独立草拟**（中书省）→ 互相**审议修订**（门下省）→ 主编**起草最终奏折**（尚书省）→ 你这个皇帝最后**朱批**。

Chrome 扩展，把 ChatGPT / Gemini / DeepSeek / Kimi 的网页 UI 串成一个**三轮多智能体审议 pipeline**。每条用户问题：

1. **R1 独立答**：每家 AI 在不知道其他家答案的前提下，独立给出结构化 `<answer>`（核心结论 / 关键推理 / 可能盲点 / 不确定的地方 / 最终建议）
2. **R2 交叉评审**：每家看到自己 + 其他家的 R1，输出 `<revision>`（共识、吸收的观点、不同意的观点、修正后的完整回答、留给主编的分歧）
3. **Final 主编合成**：指定一家（默认 Gemini）读三份 R2 输出，按"最终结论 / 综合答案 / 共识 / 分歧裁决 / 可执行方案 / 仍需验证"输出 markdown

**不调任何 API，跑用户已登录的网页 UI**——目的是榨干你已经付的月费订阅。

## 快速开始

1. clone 这个 repo
2. Chrome 打开 `chrome://extensions` → 右上角开"开发者模式"
3. 点 "加载已解压的扩展程序" → 选这个目录
4. 分别登录 [chatgpt.com](https://chatgpt.com) / [gemini.google.com](https://gemini.google.com) / [chat.deepseek.com](https://chat.deepseek.com) / [www.kimi.com](https://www.kimi.com)
5. 浏览器右上角扩展图标 → 打开 sidepanel
6. 选好"参与"和"合成"，输入问题 → 发送

## 当前支持的模型

| | 站点 | 隐私模式 | 备注 |
|---|---|---|---|
| ChatGPT  | chatgpt.com | 临时对话（不存历史） | 用 `?temporary-chat=true` URL |
| Gemini   | gemini.google.com | 临时对话 | 自动点"临时对话"按钮 |
| DeepSeek | chat.deepseek.com | 普通模式 | DS 无 native 临时对话 |
| Kimi     | www.kimi.com | 普通模式 | |

## 主要功能

- 多轮聊天 UI（气泡布局，markdown 输出，本地持久化）
- 4 家任意组合"参与" + 任一家做"合成"——可以让 ChatGPT/DeepSeek 互掐，Gemini 当裁判
- 暗黑模式（跟随系统 / 手动切换 / 持久化）
- "查看推理过程"——展开看 R1/R2 三家原始输出
- pipeline 中途**可取消**
- 每轮跑完自动关掉 AI tab，浏览器干净
- Debug bundle 一键导出（实时探针 + 错误日志 + 各家 stage）

## 架构

```
manifest.json           MV3 扩展声明
background.js           service worker
                          - tab 管理（开、reload、关、轮转 keepalive）
                          - pipeline 编排（R1/R2/Final 三阶段，并行+串行混合）
                          - prompt 模板（含历史注入）
                          - SW 主动 executeScript 轮询，绕开后台 tab 节流
content_adapter.js      content script
                          - 通用 adapter（input 注入、send 点击、轮询 DOM）
                          - 4 家 SelectorConfig
                          - window.__multiAIPollState 探针
sidepanel.html / .js    侧边栏聊天 UI
                          - 对话状态 + 持久化（chrome.storage.local）
                          - provider pills + final dropdown
                          - 主题切换 / 调试 bundle 导出
```

## 文档

- [想法](想法) —— 项目最初的设计草稿，记录了为什么这么设计、哪些坑提前考虑过
- [OPTIMIZATIONS.md](OPTIMIZATIONS.md) —— 待优化项的 backlog，按 P0/P1/P2/P3 分级

## 注意事项 / 风险

- **ToS 风险**：自动化操作 ChatGPT / Gemini 等的网页 UI 可能违反它们的服务条款。**自用风险自担**，本项目不做任何反自动化检测对抗。
- **Token 消耗**：每条消息要跑 R1+R2+Final 共 7 次模型调用（3+3+1）。Plus / Pro 账号有 message cap，重度使用容易撞上限
- **不绕验证码 / 不藏自动化痕迹**：如果某家加强反自动化、加 captcha 强制等，本项目会停止对那家的支持
- **隐私**：对话存在本地 `chrome.storage.local`，未加密。任何能读你 Chrome profile 的人能看到聊天内容

## License

MIT
