# Optimization Backlog

当前实现为 v0.79。本页保留历史决策与仍可继续做的事项；已实现或部分实现的条目会明确标注。实际架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 为准，早期的独立 provider tab / `ourTabs` 描述不再代表主 pipeline。

---

## P0 — 用户体验直接相关

### ~~1. ChatGPT / Gemini 走 fallback 而不是 primary 判停~~ (v0.05 已部分解决)

**已做**：fallback 从 11s 缩到 7s。配合下面的轮转 keepalive，DOM 刷新更可靠，3s primary 路径更容易触发。每 round 节省 4-6s。

**未来如果还想再压速度**：
- 用 `MutationObserver` 监听 stop 按钮的 attribute 变化，事件驱动推送 SW，不靠轮询
- 检测 send button 的 aria-label 从"停止"恢复成"发送"作为正向完成信号

### ~~2. Keepalive 闪烁太频繁~~ (v0.05 已解决)

**已做**：从"每 1s 闪 350ms"改成**纯轮转**——三家 AI tab 每 2s 接力当 active，用户 tab 在 phase 3 期间完全让位（约 30s/round），结束后自动还原。零闪烁。

**未来如果想让用户 tab 在 phase 3 也可用**：
- 检测用户主动操作（mousemove、keydown），active 时整段暂停 keepalive，让位给用户
- 把 AI tab 全部丢到一个独立窗口，最小化或放副屏，主窗口完全不受影响

### 3. 单 provider debug 按钮跑的 prompt 没用 R1 模板

**现状**：debug 按钮直接发原始 prompt。Run Full Pipeline 用结构化 R1 模板。两种行为不一致。

**方案**：在单 provider 卡片旁加一个 toggle：raw vs structured。默认 raw（debug 用），切换 structured 看真实 R1 输出。

---

## P1 — 鲁棒性

### ~~4. Pipeline 部分失败的容错~~（v0.79 已解决）

**已做**：R1 或 R2 允许单家失败；只要至少 2 家成功就继续，后续 prompt 只使用成功输出。少于 2 家时明确失败，不把单模型答案伪装成共识。

**方案**：
- R1 至少 2/3 成功就继续进 R2（缺失那家在 R2 prompt 里标记 "this provider failed, no input"）
- R2 至少 2/3 成功就进 Final
- 三家全失败才彻底 abort

### ~~5. 单家失败的 retry~~（v0.56-v0.59 已解决）

**已做**：针对空输出、生成超时、message channel/receiver 丢失等瞬时错误，每个 provider 自动 reload、重新注入并重试一次。非瞬时错误和取消不会盲目重试。

**方案**：在 `runProviderJob` 包一层 retry，最多 1 次重试，间隔 3s。已经成功 submit 的不重试（避免重复扣 token）。

### 6. 临时对话与历史清理仍依赖网页行为

**现状**：主 pipeline 的 ChatGPT 仍使用 `?temporary-chat=true`；Gemini iframe 使用普通会话，并提供“清 Gemini”批量删除工具。Relay 因临时会话不稳定而明确使用 ChatGPT 普通新对话。

**方案**：进入 ChatGPT 后探测临时对话标志（页面顶部"temporary"文字 / specific class），不在则告警。

### 7. Pipeline 的 SW 重启恢复

**现状**：旧 `ourTabs` 架构已移除。frame 注册和当前 `AbortController` 仍在内存中；debug 状态可部分恢复，iframe reload 后会重新注册。普通 pipeline 尚不能在 service worker 中途死亡后从精确 stage 自动续跑。Relay 另有持久化 queue/in-flight/offset 恢复。

**方案**：用 `chrome.storage.session`（SW 重启不丢）持久化 ourTabs。SW 启动时恢复。

---

## P2 — 功能扩展

### 8. Conflict Extractor（原想法第 17 节）

**现状**：直接 R2 → Final。Final editor 容易当摘要器，把真实分歧磨平。

**方案**：在 R2 之后、Final 之前插一个轻量步骤——用最便宜的 provider（DeepSeek）从三份 R2 里只抽冲突点，作为 Final prompt 的额外输入。

### 9. 早停（如果 R1 高度一致）

**现状**：R1 三家答案高度一致也强行跑 R2 + Final，浪费 ~50s 和 token。

**方案**：R1 后做一个 cheap check（embedding 余弦 / 一段轻量 prompt 让某家判一下），相似度 > 阈值直接跳过 R2，输出汇总。

### ~~10. Round-level 持久化 + 查看历史~~（v0.15 起已实现当前会话版本）

**已做**：`conversation` 保存在 `chrome.storage.local`；assistant 消息保存 Final 及 R1/R2 映射，页面恢复后可继续展开查看。当前仍是单会话数据，没有独立的多 run 历史浏览器或导入/导出索引。

**方案**：用 `chrome.storage.local` 存最近 N 次 run 的完整 RunState（user prompt、各 round 输出、final）。side panel 加"历史"切换。

### 11. 全阶段流式渲染输出

**部分实现**：Final 已通过 `PROVIDER_UPDATE.partialOutput` 实时渲染；R1/R2 仍在 provider 完成后一次性保存和展示。

**方案**：SW 轮询时把 latest text 也通过 PROVIDER_UPDATE 流给 side panel，side panel 实时更新 card body，用户能看到生成过程。

---

## P3 — 工程清理

### 12. content_adapter.js 越来越大

**现状**：一个文件塞了 utilities + 三家 config + 通用 adapter + probe + window 暴露。

**方案**：拆成 `utils.js` + `providers/{chatgpt,gemini,deepseek}.js` + `adapter.js`。需要 build 步骤（esbuild 一行命令）或手写 import。可以等到加更多 provider 时再做。

### 13. 单元测试 / 回归测试

**现状**：每次改 selector 都得手工跑一次 round 1 验证。

**方案**：写一个最小测试页（fake DOM 模拟三家的输入框 + 发送按钮 + 回复区），跑 adapter 的 setInputValue / submitPrompt / waitForGenerationEnd，断言行为。每次改 selector 前先跑测试。

### 14. 增加更多 provider

**现状**：已支持 ChatGPT / Gemini / DeepSeek / Kimi。新增 provider 仍需同步 manifest、iframe、adapter、UI、prompt role 和 debug 输出。

**候选**（按优先级）：
- Claude (claude.ai) — 用户当前因 token 节省排除，但以后可能加回
- Qwen (chat.qwen.ai) — 中文 perspective + 免费

每加一个写一份 SelectorConfig + 测试。

---
