可以，那就按 **全自动网页驾驶版** 来设计。

先说一句工程边界：我不会写绕验证码、隐藏自动化痕迹、突破速率限制这类东西；但在你自己已经正常登录各个网页 AI 的前提下，**Chrome 插件自动开页面、注入 prompt、点击发送、等待回答完成、读取回答、进入下一轮**，这个可以完整设计。

---

# 1. 最推荐架构：Chrome Extension MV3 + Side Panel + Content Script Adapters

核心不是让一个脚本硬怼三个网页，而是做成：

```text
Side Panel UI
  ↓
Background Orchestrator
  ↓
Tab Manager
  ↓
Provider Adapters
  ├── ChatGPT Adapter
  ├── Gemini Adapter
  └── DeepSeek Adapter
  ↓
Run State Store
```

Chrome 扩展里，`chrome.tabs` 可以创建和管理标签页，`chrome.scripting` 可以运行时注入脚本，content script 可以读写页面 DOM；Side Panel 适合做常驻控制台；状态用 `chrome.storage` 存。Chrome MV3 的 background 是 service worker，可能被浏览器中止，所以流程状态必须持久化，不能只放内存里。([Chrome for Developers][1])

---

# 2. 文件结构

```text
multi-ai-orchestrator/
  manifest.json

  src/
    background/
      service_worker.ts
      tab_manager.ts
      orchestrator.ts

    sidepanel/
      index.html
      app.tsx

    content/
      common/
        dom_utils.ts
        wait_utils.ts
        provider_base.ts
      providers/
        chatgpt.ts
        gemini.ts
        deepseek.ts

    core/
      types.ts
      prompt_templates.ts
      run_store.ts
      scheduler.ts
```

关键思想：

```text
orchestrator.ts 只管流程
provider adapter 只管具体网页怎么操作
run_store.ts 只管保存状态
sidepanel 只管展示和控制
```

不要把 ChatGPT/Gemini/DeepSeek 的 DOM 操作写进 orchestrator，否则后面网页一变，整个系统都烂。

---

# 3. manifest.json

```json
{
  "manifest_version": 3,
  "name": "Multi AI Orchestrator",
  "version": "0.1.0",
  "description": "Fully automated multi-AI deliberation workflow using web UIs.",
  "permissions": [
    "tabs",
    "scripting",
    "storage",
    "sidePanel"
  ],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*",
    "https://chat.deepseek.com/*"
  ],
  "background": {
    "service_worker": "dist/background/service_worker.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "dist/sidepanel/index.html"
  },
  "action": {
    "default_title": "Multi AI Orchestrator"
  },
  "content_scripts": [
    {
      "matches": [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://chat.deepseek.com/*"
      ],
      "js": ["dist/content/content_router.js"],
      "run_at": "document_idle"
    }
  ]
}
```

这里有两种注入方式：

1. `content_scripts`：页面加载后自动注入。
2. `chrome.scripting.executeScript`：后台根据当前 tab 动态注入。

我建议两个都支持。默认 content script 常驻，必要时 background 再动态注入一次。Chrome 文档里也明确 `chrome.scripting` 可以在运行时向网站注入 JS/CSS；content scripts 默认在 isolated world 中运行，也可以配置执行环境。([Chrome for Developers][2])

---

# 4. 核心状态结构

```ts
export type ProviderId = "chatgpt" | "gemini" | "deepseek";

export type RunPhase =
  | "idle"
  | "round1"
  | "round2"
  | "synthesis"
  | "done"
  | "failed";

export type JobStatus =
  | "pending"
  | "tab_opening"
  | "injecting"
  | "submitting"
  | "generating"
  | "capturing"
  | "done"
  | "failed";

export interface ProviderJob {
  provider: ProviderId;
  tabId?: number;
  url: string;
  status: JobStatus;
  prompt: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunState {
  id: string;
  userPrompt: string;
  phase: RunPhase;

  providers: ProviderId[];
  editorProvider: ProviderId;

  round1: Record<ProviderId, ProviderJob>;
  round2: Record<ProviderId, ProviderJob>;
  synthesis?: ProviderJob;

  createdAt: number;
  updatedAt: number;
}
```

因为 MV3 service worker 可能被暂停，所以每个 phase、每个 provider job 都要落盘。否则跑一半 background 被 Chrome 回收，你的 run 就丢了。Chrome 官方也建议 extension service worker 要能承受意外终止。([Chrome for Developers][3])

---

# 5. Orchestrator 流程

你要的是这个：

```ts
async function runPipeline(userPrompt: string): Promise<void> {
  const run = await createRun(userPrompt, {
    providers: ["chatgpt", "gemini", "deepseek"],
    editorProvider: "chatgpt"
  });

  await runIndependentGeneration(run.id);
  await runCrossReference(run.id);
  await runFinalSynthesis(run.id);
}
```

展开后：

```ts
async function runIndependentGeneration(runId: string): Promise<void> {
  const run = await getRun(runId);

  const jobs = run.providers.map((provider) => {
    const prompt = buildRound1Prompt(run.userPrompt);
    return dispatchProviderJob(runId, "round1", provider, prompt);
  });

  await Promise.allSettled(jobs);
}

async function runCrossReference(runId: string): Promise<void> {
  const run = await getRun(runId);

  const jobs = run.providers.map((provider) => {
    const self = run.round1[provider].output ?? "";
    const others = run.providers
      .filter((p) => p !== provider)
      .map((p) => ({
        provider: p,
        output: run.round1[p].output ?? ""
      }));

    const prompt = buildRound2Prompt(run.userPrompt, provider, self, others);
    return dispatchProviderJob(runId, "round2", provider, prompt);
  });

  await Promise.allSettled(jobs);
}

async function runFinalSynthesis(runId: string): Promise<void> {
  const run = await getRun(runId);

  const round2Outputs = run.providers.map((provider) => ({
    provider,
    output: run.round2[provider].output ?? ""
  }));

  const prompt = buildSynthesisPrompt(run.userPrompt, round2Outputs);

  await dispatchProviderJob(
    runId,
    "synthesis",
    run.editorProvider,
    prompt
  );
}
```

`dispatchProviderJob` 做五件事：

```text
1. 找到或打开对应 AI 网页 tab
2. 等待页面 ready
3. 注入 prompt
4. 等待生成完成
5. 抓取最后一条回答
```

---

# 6. Tab Manager

```ts
const PROVIDER_URLS: Record<ProviderId, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  deepseek: "https://chat.deepseek.com/"
};

export async function getOrCreateProviderTab(
  provider: ProviderId
): Promise<number> {
  const urlPrefix = PROVIDER_URLS[provider];

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url?.startsWith(urlPrefix));

  if (existing?.id) {
    return existing.id;
  }

  const tab = await chrome.tabs.create({
    url: urlPrefix,
    active: false
  });

  if (!tab.id) {
    throw new Error(`Failed to create tab for ${provider}`);
  }

  return tab.id;
}

export async function waitForTabLoaded(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}
```

Chrome tabs API 本来就是干这个的：创建、修改、重排标签页，并且可以和 content script 通信。([Chrome for Developers][1])

---

# 7. Background 和 Content Script 通信

Background 发：

```ts
export async function sendPromptToTab(
  tabId: number,
  provider: ProviderId,
  prompt: string
): Promise<string> {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RUN_PROVIDER_JOB",
    provider,
    prompt
  });

  if (!response?.ok) {
    throw new Error(response?.error ?? "Provider job failed");
  }

  return response.output;
}
```

Content script 接：

```ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_PROVIDER_JOB") return;

  runProviderJob(message.provider, message.prompt)
    .then((output) => sendResponse({ ok: true, output }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));

  return true;
});
```

Chrome 的 message passing 就是这么用：`runtime.sendMessage` 或 `tabs.sendMessage` 发送 JSON-serializable message，另一边返回 response。([Chrome for Developers][4])

---

# 8. Provider Adapter 接口

```ts
export interface ProviderAdapter {
  id: ProviderId;

  isReady(): Promise<boolean>;

  submitPrompt(prompt: string): Promise<void>;

  waitForGenerationStart(): Promise<void>;

  waitForGenerationEnd(): Promise<void>;

  getLatestAnswer(): Promise<string>;
}
```

统一执行函数：

```ts
async function runProviderJob(
  provider: ProviderId,
  prompt: string
): Promise<string> {
  const adapter = getAdapter(provider);

  await waitUntil(() => adapter.isReady(), {
    timeoutMs: 60_000,
    intervalMs: 500
  });

  await adapter.submitPrompt(prompt);
  await adapter.waitForGenerationStart();
  await adapter.waitForGenerationEnd();

  const answer = await adapter.getLatestAnswer();

  if (!answer.trim()) {
    throw new Error(`${provider} returned empty answer`);
  }

  return answer;
}
```

---

# 9. DOM 操作工具函数

你要网页自动化，最容易挂的地方就是输入框。很多 AI 网页不是普通 `<textarea>`，而是 `contenteditable`、ProseMirror、Lexical editor。

所以要写通用函数：

```ts
export function setNativeValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string
): void {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  descriptor?.set?.call(element, value);

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setContentEditableValue(
  element: HTMLElement,
  value: string
): void {
  element.focus();

  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, value);

  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: value
  }));
}

export function clickElement(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}
```

等待工具：

```ts
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < options.timeoutMs) {
    if (await predicate()) return;
    await sleep(options.intervalMs);
  }

  throw new Error("waitUntil timeout");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

# 10. 生成结束检测：不要只靠按钮状态

网页 AI 的 completion 判断最麻烦。你需要三重判断：

```text
1. 是否出现 assistant 新消息
2. stop / generating 按钮是否消失
3. 最新回答文本是否连续 N 秒不再变化
```

通用函数：

```ts
export async function waitForStableText(
  getText: () => string,
  options: {
    stableMs: number;
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<string> {
  const start = Date.now();

  let lastText = "";
  let lastChangedAt = Date.now();

  while (Date.now() - start < options.timeoutMs) {
    const currentText = getText();

    if (currentText !== lastText) {
      lastText = currentText;
      lastChangedAt = Date.now();
    }

    const stableFor = Date.now() - lastChangedAt;

    if (currentText.trim() && stableFor >= options.stableMs) {
      return currentText;
    }

    await sleep(options.intervalMs);
  }

  throw new Error("Text did not stabilize before timeout");
}
```

建议参数：

```ts
stableMs: 3000
timeoutMs: 180000
intervalMs: 500
```

也就是文本连续 3 秒不变就认为生成结束。别设太短，不然长回答会被截断。

---

# 11. ChatGPT Adapter 示例

实际 DOM selector 会变，所以你要写多个 fallback selector。

```ts
import {
  setContentEditableValue,
  setNativeValue,
  clickElement,
  waitUntil,
  waitForStableText
} from "../common/dom_utils";

export class ChatGPTAdapter implements ProviderAdapter {
  id = "chatgpt" as const;

  async isReady(): Promise<boolean> {
    return Boolean(this.findInput());
  }

  async submitPrompt(prompt: string): Promise<void> {
    const input = this.findInput();

    if (!input) {
      throw new Error("ChatGPT input not found");
    }

    if (input instanceof HTMLTextAreaElement) {
      setNativeValue(input, prompt);
    } else {
      setContentEditableValue(input, prompt);
    }

    await waitUntil(() => Boolean(this.findSendButton()), {
      timeoutMs: 10_000,
      intervalMs: 300
    });

    const button = this.findSendButton();

    if (!button) {
      throw new Error("ChatGPT send button not found");
    }

    clickElement(button);
  }

  async waitForGenerationStart(): Promise<void> {
    await waitUntil(() => {
      return this.getAssistantMessages().length > 0;
    }, {
      timeoutMs: 30_000,
      intervalMs: 500
    });
  }

  async waitForGenerationEnd(): Promise<void> {
    await waitForStableText(() => this.getLatestAnswerSync(), {
      stableMs: 3000,
      timeoutMs: 180000,
      intervalMs: 500
    });
  }

  async getLatestAnswer(): Promise<string> {
    return this.getLatestAnswerSync();
  }

  private findInput(): HTMLElement | null {
    return (
      document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('[role="textbox"]')
    );
  }

  private findSendButton(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll("button")
    ) as HTMLElement[];

    return candidates.find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("data-testid"),
        button.textContent
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        label.includes("send") ||
        label.includes("submit") ||
        label.includes("发送")
      );
    }) ?? null;
  }

  private getAssistantMessages(): HTMLElement[] {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"]',
      ".markdown"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(
        document.querySelectorAll(selector)
      ) as HTMLElement[];

      if (nodes.length > 0) return nodes;
    }

    return [];
  }

  private getLatestAnswerSync(): string {
    const messages = this.getAssistantMessages();
    const latest = messages[messages.length - 1];

    return latest?.innerText?.trim() ?? "";
  }
}
```

---

# 12. Gemini / DeepSeek Adapter 不要完全复制，要配置化

写一个 `SelectorConfig`：

```ts
interface SelectorConfig {
  inputSelectors: string[];
  sendButtonHints: string[];
  assistantMessageSelectors: string[];
}
```

然后：

```ts
const PROVIDER_SELECTOR_CONFIG: Record<ProviderId, SelectorConfig> = {
  chatgpt: {
    inputSelectors: [
      "textarea",
      '[contenteditable="true"]',
      '[role="textbox"]'
    ],
    sendButtonHints: ["send", "submit", "发送"],
    assistantMessageSelectors: [
      '[data-message-author-role="assistant"]',
      ".markdown",
      '[data-testid*="conversation-turn"]'
    ]
  },

  gemini: {
    inputSelectors: [
      "rich-textarea div[contenteditable='true']",
      '[contenteditable="true"]',
      '[role="textbox"]'
    ],
    sendButtonHints: ["send", "submit", "发送"],
    assistantMessageSelectors: [
      "message-content",
      ".model-response-text",
      ".response-container"
    ]
  },

  deepseek: {
    inputSelectors: [
      "textarea",
      '[contenteditable="true"]',
      '[role="textbox"]'
    ],
    sendButtonHints: ["send", "发送"],
    assistantMessageSelectors: [
      ".ds-markdown",
      ".markdown",
      "[class*='message']"
    ]
  }
};
```

然后做一个通用 adapter：

```ts
export class GenericWebAIAdapter implements ProviderAdapter {
  constructor(
    public id: ProviderId,
    private config: SelectorConfig
  ) {}

  async isReady(): Promise<boolean> {
    return Boolean(this.findInput());
  }

  async submitPrompt(prompt: string): Promise<void> {
    const input = this.findInput();

    if (!input) {
      throw new Error(`${this.id}: input not found`);
    }

    if (input instanceof HTMLTextAreaElement) {
      setNativeValue(input, prompt);
    } else {
      setContentEditableValue(input, prompt);
    }

    await sleep(500);

    const sendButton = this.findSendButton();

    if (!sendButton) {
      this.pressEnter(input);
      return;
    }

    clickElement(sendButton);
  }

  async waitForGenerationStart(): Promise<void> {
    const beforeCount = this.getAssistantMessages().length;

    await waitUntil(() => {
      return this.getAssistantMessages().length > beforeCount;
    }, {
      timeoutMs: 45_000,
      intervalMs: 500
    });
  }

  async waitForGenerationEnd(): Promise<void> {
    await waitForStableText(() => this.getLatestAnswerSync(), {
      stableMs: 3500,
      timeoutMs: 240000,
      intervalMs: 500
    });
  }

  async getLatestAnswer(): Promise<string> {
    return this.getLatestAnswerSync();
  }

  private findInput(): HTMLElement | null {
    for (const selector of this.config.inputSelectors) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) return el;
    }

    return null;
  }

  private findSendButton(): HTMLElement | null {
    const buttons = Array.from(document.querySelectorAll("button")) as HTMLElement[];

    return buttons.find((button) => {
      const text = [
        button.textContent,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.getAttribute("data-testid")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return this.config.sendButtonHints.some((hint) =>
        text.includes(hint.toLowerCase())
      );
    }) ?? null;
  }

  private getAssistantMessages(): HTMLElement[] {
    for (const selector of this.config.assistantMessageSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      if (nodes.length > 0) return nodes;
    }

    return [];
  }

  private getLatestAnswerSync(): string {
    const messages = this.getAssistantMessages();
    return messages[messages.length - 1]?.innerText?.trim() ?? "";
  }

  private pressEnter(input: HTMLElement): void {
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));

    input.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
  }
}
```

---

# 13. 最重要的工程技巧：每轮最好新开一个 conversation

不要在同一个 AI 聊天窗口里连续塞 Round 1、Round 2、Final。因为上下文会污染，而且不同网页的历史上下文机制不一样。

建议：

```text
Round 1:
  ChatGPT new chat
  Gemini new chat
  DeepSeek new chat

Round 2:
  ChatGPT new chat
  Gemini new chat
  DeepSeek new chat

Final:
  ChatGPT new chat
```

也就是每个 job 都是独立 tab 或独立 conversation。

Tab 命名逻辑：

```text
chatgpt_round1
gemini_round1
deepseek_round1
chatgpt_round2
gemini_round2
deepseek_round2
chatgpt_final
```

实际 Chrome tab 没有自定义名字，所以你在 `RunState` 里记录：

```ts
tabMap: {
  "chatgpt_round1": 123,
  "gemini_round1": 124,
  ...
}
```

这样失败后可以恢复。

---

# 14. Prompt 模板要更“机器可解析”

你不要让第二轮自由发挥。让每个 AI 输出固定结构，最后更好合成。

## Round 1

```text
你是一个独立分析 agent。不要引用其他模型观点，因为你现在看不到它们。

用户问题：
{{USER_PROMPT}}

请严格按以下格式输出：

<answer>
核心结论：
...

关键推理：
1. ...
2. ...
3. ...

可能的盲点：
1. ...
2. ...

我最不确定的地方：
...

最终建议：
...
</answer>
```

## Round 2

```text
你是交叉评审 agent。你将看到自己的第一轮回答，以及其他两个模型的第一轮回答。

原始用户问题：
{{USER_PROMPT}}

你的第一轮回答：
<self_answer>
{{SELF_R1}}
</self_answer>

其他模型回答：
<other_answer provider="{{OTHER_PROVIDER_1}}">
{{OTHER_R1_1}}
</other_answer>

<other_answer provider="{{OTHER_PROVIDER_2}}">
{{OTHER_R1_2}}
</other_answer>

请严格按以下格式输出：

<revision>
共识：
...

我吸收的观点：
1. 来自 {{OTHER_PROVIDER_1}}：...
2. 来自 {{OTHER_PROVIDER_2}}：...

我不同意的观点：
1. ...
2. ...

修正后的完整回答：
...

仍然存在的分歧：
...
</revision>
```

## Final Synthesis

```text
你是最终主编。你的任务不是平均三份答案，而是判断、去重、合并、裁剪、解决矛盾。

原始用户问题：
{{USER_PROMPT}}

三份第二轮回答如下：

<revised_answer provider="chatgpt">
{{CHATGPT_R2}}
</revised_answer>

<revised_answer provider="gemini">
{{GEMINI_R2}}
</revised_answer>

<revised_answer provider="deepseek">
{{DEEPSEEK_R2}}
</revised_answer>

请输出：

# 最终结论

# 综合答案

# 三个模型的主要共识

# 主要分歧与裁决

# 可执行方案

# 仍需验证的信息
```

这种 XML-ish 包装很好用，模型不容易混淆边界。

---

# 15. 失败恢复机制

全自动网页 UI 最大的问题不是“做不到”，而是“跑一半失败”。所以必须有 job-level retry。

```ts
async function dispatchProviderJob(
  runId: string,
  phase: "round1" | "round2" | "synthesis",
  provider: ProviderId,
  prompt: string
): Promise<void> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      await updateJob(runId, phase, provider, {
        status: "tab_opening",
        prompt,
        startedAt: Date.now()
      });

      const tabId = await getOrCreateProviderTab(provider);

      await updateJob(runId, phase, provider, {
        tabId,
        status: "injecting"
      });

      await waitForTabLoadedOrReady(tabId);

      await updateJob(runId, phase, provider, {
        status: "submitting"
      });

      const output = await sendPromptToTab(tabId, provider, prompt);

      await updateJob(runId, phase, provider, {
        status: "done",
        output,
        finishedAt: Date.now()
      });

      return;
    } catch (error) {
      if (attempt > maxRetries) {
        await updateJob(runId, phase, provider, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }

      await sleep(3000);
    }
  }
}
```

失败类型要分清楚：

```ts
type FailureReason =
  | "not_logged_in"
  | "input_not_found"
  | "send_button_not_found"
  | "generation_timeout"
  | "empty_output"
  | "tab_crashed"
  | "network_error"
  | "unknown";
```

---

# 16. Side Panel UI 最小功能

你自己用的话，UI 不用花哨，但要有这些：

```text
[Prompt 输入框]

Providers:
[x] ChatGPT
[x] Gemini
[x] DeepSeek

Final Editor:
(o) ChatGPT
( ) Gemini
( ) DeepSeek

[Run Full Pipeline]

Round 1
ChatGPT   done / failed / retry
Gemini    done / failed / retry
DeepSeek  done / failed / retry

Round 2
...

Final
...

[Copy Final Markdown]
[Export JSON]
[Open Debug Logs]
```

Side Panel 很适合这个，因为它可以在浏览时保持一个持久侧边栏。([Chrome for Developers][5])

---

# 17. 最强版：加“自动质量裁判”

我建议你在 Final Synthesis 前插一个内部步骤：

```text
Round 2 outputs
  ↓
Conflict Extractor
  ↓
Final Editor
```

这个 Conflict Extractor 可以直接让最终主编 AI 做，也可以单独发给一个模型。

Prompt：

```text
请只提取三份回答之间的冲突，不要写最终答案。

输出：
1. 共识点
2. 事实冲突
3. 方法冲突
4. 建议冲突
5. 哪些内容可以直接合并
6. 哪些内容必须由最终主编裁决
```

然后 Final Editor 看到：

```text
用户问题
+ 三份 revised answers
+ conflict map
```

最终质量会明显上去。否则 final editor 容易变成“高级摘要器”，把真正的分歧磨平。

---

# 18. 实际运行顺序

完整自动化应该是：

```text
用户点击 Run
  ↓
创建 RunState
  ↓
打开三个网页 AI tab
  ↓
等待三个页面 ready
  ↓
Round 1 并行提交 prompt
  ↓
三个 content script 各自等待输出稳定
  ↓
background 收集 A1/B1/C1
  ↓
生成 Round 2 prompt
  ↓
新开或重置三个 conversation
  ↓
Round 2 并行提交
  ↓
收集 A2/B2/C2
  ↓
生成 final prompt
  ↓
发送给 editorProvider
  ↓
等待输出稳定
  ↓
保存 final answer
  ↓
side panel 展示最终报告
```

---

# 19. 最终建议：先别做得太“智能”，先做得很“笨但稳”

你的 V0.1 目标应该是：

```text
输入一个问题
→ 自动发给 3 个网页 AI
→ 自动抓 3 个回答
→ 自动发第二轮
→ 自动抓第二轮
→ 自动发 final
→ 自动拿最终答案
```

不要一开始就加：

```text
自动判断哪个模型更适合
自动动态换模型
自动无限轮讨论
自动搜索网页
自动读取当前页面内容
自动 Obsidian 同步
```

这些都后面加。

最小可行核心是：

```text
Tab Manager
+ Provider Adapter
+ Prompt Templates
+ RunState
+ Stable Text Capture
```

把这五个做稳，你这个系统就真的能跑起来。

---

# 20. 一个很实用的开发路线

## Day 1：只支持 ChatGPT 单模型自动提交和抓取

目标：

```text
side panel 输入 prompt
→ 自动发送到 ChatGPT
→ 自动抓回答
→ 展示在 side panel
```

## Day 2：抽象 ProviderAdapter，加 Gemini / DeepSeek

目标：

```text
同一个 submitPrompt / waitForGenerationEnd / getLatestAnswer 接口
适配三个网页
```

## Day 3：实现 Round 1 并行

目标：

```text
一次问题 → 三个 AI 同时回答
```

## Day 4：实现 Round 2 和 Final

目标：

```text
完整三段式 pipeline
```

## Day 5：做失败恢复和 debug panel

目标：

```text
哪个网页挂了，一眼能看见
可以 retry 单个 provider
可以导出 run JSON
```

---

