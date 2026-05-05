(() => {
  if (window.__multiAIOrchestratorInstalled) return;
  window.__multiAIOrchestratorInstalled = true;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitUntil(predicate, { timeoutMs, intervalMs }) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await predicate();
      if (v) return v;
      await sleep(intervalMs);
    }
    throw new Error('waitUntil timeout');
  }

  function findFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAll(selectors) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    }
    return [];
  }

  function findButtonByHints(hints) {
    if (!hints || hints.length === 0) return null;
    // Include both <button> and any element with role="button" (e.g. DeepSeek)
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );
    return candidates.find(b => {
      const label = [
        b.getAttribute('aria-label'),
        b.getAttribute('data-testid'),
        b.getAttribute('title'),
        b.textContent
      ].filter(Boolean).join(' ').toLowerCase();
      return hints.some(h => label.includes(h.toLowerCase()));
    }) ?? null;
  }

  function robustClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}

    // Native <button>/<a>/<input>: just call .click(). Dispatching extra
    // mouse events first confuses Material/Angular state machines and the
    // real click ends up being de-duped/ignored.
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') {
      el.click();
      return;
    }

    // Custom controls like <div role="button"> (DeepSeek): no native click
    // behavior, must dispatch the full pointer/mouse sequence.
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function isButtonEnabled(b) {
    if (!b) return false;
    if (b.disabled) return false;
    if (b.hasAttribute('disabled')) return false;
    if (b.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  // =================== Provider configs ===================

  const PROVIDER_CONFIGS = {
    chatgpt: {
      inputSelectors: [
        '#prompt-textarea',
        'div[contenteditable="true"]',
        'textarea'
      ],
      sendButtonSelectors: [
        'button[data-testid="send-button"]',
        'button[data-testid="fruitjuice-send-button"]',
        'button[aria-label="Send prompt"]'
      ],
      sendButtonHints: ['send', 'submit', '发送'],
      stopButtonSelectors: [
        'button[data-testid="stop-button"]',
        'button[data-testid="composer-stop-button"]',
        'button[data-testid*="stop" i]',
        'button[aria-label*="Stop" i]',
        'button[aria-label*="停止"]'
      ],
      streamingIndicatorSelectors: [
        '.result-streaming',
        '[class*="result-streaming"]',
        '[data-message-status="streaming"]'
      ],
      assistantMessageSelectors: [
        '[data-message-author-role="assistant"]'
      ],
      newChatButtonSelectors: [],
      newChatButtonHints: []
    },
    gemini: {
      inputSelectors: [
        'rich-textarea div[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea'
      ],
      sendButtonSelectors: [
        'button[aria-label="发送"]',
        'button.send-button',
        'button[aria-label="Send message"]'
      ],
      sendButtonHints: ['发送', 'send message', 'submit'],
      stopButtonSelectors: [
        'button[aria-label*="Stop"]',
        'button[aria-label*="停止"]',
        '.stop-generating'
      ],
      assistantMessageSelectors: [
        'message-content',
        '.model-response-text',
        '.markdown.markdown-main-panel'
      ],
      newChatButtonSelectors: [
        '[data-test-id="temp-chat-button"]',
        'button[aria-label="临时对话"]',
        '[data-test-id="new-chat-button"]',
        'button[aria-label*="New chat"]',
        'button[aria-label*="新对话"]'
      ],
      newChatButtonHints: ['临时对话', 'temporary chat', 'new chat', '新对话']
    },
    kimi: {
      // Best-effort selectors — verify with first run + Copy debug
      inputSelectors: [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
        '[role="textbox"]'
      ],
      sendButtonSelectors: [
        'button[aria-label*="发送"]',
        'button[aria-label*="Send" i]',
        'div[role="button"][aria-label*="发送"]'
      ],
      sendButtonHints: ['发送', 'send'],
      stopButtonSelectors: [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop" i]',
        'div[role="button"][aria-label*="停止"]'
      ],
      assistantMessageSelectors: [
        '[data-role="assistant"]',
        '[class*="assistant-message"]',
        '[class*="message-assistant"]',
        '[class*="bot-message"]',
        '[class*="assistant"][class*="message"]',
        '.markdown'
      ],
      newChatButtonSelectors: [
        'button[aria-label*="新对话"]',
        'button[aria-label*="新会话"]',
        'button[aria-label*="新建对话"]',
        'button[aria-label*="New chat" i]',
        'a[aria-label*="新对话"]'
      ],
      newChatButtonHints: ['新对话', '新会话', '新建对话', 'new chat']
    },
    deepseek: {
      inputSelectors: [
        '#chat-input',
        'textarea[placeholder*="DSeek"]',
        'textarea[placeholder*="DeepSeek"]',
        'textarea[name="search"]',
        'textarea[placeholder*="询问"]',
        'textarea',
        'div[contenteditable="true"]'
      ],
      sendButtonSelectors: [],
      sendButtonHints: ['send', '发送'],
      useStructuralSendFinder: true,
      stopButtonSelectors: [
        'div[role="button"][aria-label*="Stop"]',
        'button[aria-label*="Stop"]',
        'button[aria-label*="停止"]'
      ],
      assistantMessageSelectors: [
        '.ds-markdown',
        '[class*="message_assistant"]',
        '[class*="assistant-message"]'
      ],
      newChatButtonSelectors: [
        'a[href="/"]',
        'div[class*="new-chat"]',
        'button[class*="new-chat"]'
      ],
      newChatButtonHints: ['new chat', '新对话', '新建对话', '开启新对话']
    }
  };

  function detectConfig() {
    const host = window.location.hostname;
    if (host === 'chatgpt.com' || host === 'chat.openai.com') {
      return { id: 'chatgpt', ...PROVIDER_CONFIGS.chatgpt };
    }
    if (host === 'gemini.google.com') {
      return { id: 'gemini', ...PROVIDER_CONFIGS.gemini };
    }
    if (host === 'chat.deepseek.com') {
      return { id: 'deepseek', ...PROVIDER_CONFIGS.deepseek };
    }
    if (host === 'www.kimi.com' || host === 'kimi.com') {
      return { id: 'kimi', ...PROVIDER_CONFIGS.kimi };
    }
    return null;
  }

  const config = detectConfig();
  if (!config) return;

  // Exposed for SW-driven polling. SW calls this via chrome.scripting.executeScript
  // every poll tick — that synchronous invocation forces the tab's event loop to
  // run, which keeps framework re-renders flushing even when the tab is hidden.
  window.__multiAIPollState = function () {
    try {
      const messages = getAssistantMessages();
      const text = messages[messages.length - 1]?.innerText ?? '';
      return {
        provider: config.id,
        text,
        stopVisible: !!findStopButton(),
        streaming: isStreaming(),
        messageCount: messages.length
      };
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  };

  // =================== Generic adapter ===================

  function findInput() {
    return findFirst(config.inputSelectors);
  }

  function findSendButton() {
    const direct = findFirst(config.sendButtonSelectors);
    if (direct) return direct;
    const hinted = findButtonByHints(config.sendButtonHints);
    if (hinted) return hinted;
    if (config.useStructuralSendFinder) {
      return findStructuralSendButton();
    }
    return null;
  }

  // For sites where the send button has unstable hashed class names and no
  // aria-label (e.g. DeepSeek). Walk up from the input and pick the last
  // role=button icon button as the send action (rightmost in input toolbar).
  function findStructuralSendButton() {
    const input = findInput();
    if (!input) return null;

    let container = input.closest('div');
    for (let i = 0; i < 6 && container; i++) {
      const candidates = Array.from(
        container.querySelectorAll('div[role="button"], button')
      ).filter(el => {
        const cls = el.className?.toString() ?? '';
        // icon-button shaped controls (have an SVG inside)
        return el.querySelector('svg') &&
          !cls.includes('toggle-button') &&
          el.getAttribute('aria-disabled') !== 'true';
      });
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
      container = container.parentElement;
    }
    return null;
  }

  function findStopButton() {
    return findFirst(config.stopButtonSelectors);
  }

  function findNewChatButton() {
    const direct = findFirst(config.newChatButtonSelectors);
    if (direct) return direct;
    return findButtonByHints(config.newChatButtonHints);
  }

  function getAssistantMessages() {
    return findAll(config.assistantMessageSelectors);
  }

  function getLatestAssistantText() {
    const msgs = getAssistantMessages();
    return msgs[msgs.length - 1]?.innerText?.trim() ?? '';
  }

  function setInputValue(input, value) {
    input.focus();

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // contenteditable: try execCommand first — it triggers the
    // beforeinput→input event chain that Quill / Lexical / ProseMirror
    // all listen to. Paste events get filtered by Quill specifically.
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch (_) {}

    const got = (input.innerText ?? '') + (input.textContent ?? '');
    if (!inserted || !got.includes(value.slice(0, Math.min(10, value.length)))) {
      // fallback: paste event (works for some Lexical builds)
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      input.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    }
  }

  async function ensureNewChat() {
    if (config.id === 'chatgpt') return; // ?temporary-chat=true handles it via URL

    // Gemini specifically: gemini.google.com/app auto-redirects to the most
    // recent conversation. Clicking "临时对话" while inside a saved conversation
    // doesn't put THIS chat into temp mode. We have to first click "新对话"
    // to leave the saved conversation, then click "临时对话".
    if (config.id === 'gemini') {
      const newChat = await waitUntil(
        () => {
          const b = document.querySelector('[data-test-id="new-chat-button"]');
          return isButtonEnabled(b) ? b : null;
        },
        { timeoutMs: 5000, intervalMs: 250 }
      ).catch(() => null);
      if (newChat) {
        robustClick(newChat);
        await sleep(800);
      }
    }

    // Now click the priority new-chat-style button. For Gemini that's the
    // temp-chat-button (highest priority in newChatButtonSelectors). For
    // DeepSeek it's the regular new-chat link.
    const btn = await waitUntil(
      () => {
        const b = findNewChatButton();
        return isButtonEnabled(b) ? b : null;
      },
      { timeoutMs: 10000, intervalMs: 250 }
    ).catch(() => null);

    if (!btn) return;
    robustClick(btn);
    await sleep(1000);
  }

  function pressEnter(input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function submitPrompt(prompt) {
    let input = await waitUntil(
      () => findInput(),
      { timeoutMs: 30000, intervalMs: 300 }
    );
    const beforeCount = getAssistantMessages().length;

    setInputValue(input, prompt);
    await sleep(300);

    // if framework swapped the node out from under us, re-query and retry once
    const textIn = input instanceof HTMLTextAreaElement
      ? input.value
      : input.innerText;
    if (!textIn || !textIn.includes(prompt.slice(0, Math.min(10, prompt.length)))) {
      const fresh = findInput();
      if (fresh && fresh !== input) {
        input = fresh;
        setInputValue(input, prompt);
        await sleep(300);
      }
    }

    let sendBtn = null;
    try {
      sendBtn = await waitUntil(
        () => {
          const b = findSendButton();
          return isButtonEnabled(b) ? b : null;
        },
        { timeoutMs: 4000, intervalMs: 200 }
      );
    } catch (_) {}

    if (sendBtn) {
      robustClick(sendBtn);
    } else {
      pressEnter(input);
    }

    // if submission didn't start, fall back to Enter
    await sleep(1200);
    if (getAssistantMessages().length === beforeCount) {
      pressEnter(input);
    }

    return beforeCount;
  }

  async function waitForGenerationStart(beforeCount) {
    await waitUntil(
      () => getAssistantMessages().length > beforeCount,
      { timeoutMs: 60000, intervalMs: 500 }
    );
  }

  function isStreaming() {
    const sels = config.streamingIndicatorSelectors;
    if (!sels || sels.length === 0) return false;
    for (const sel of sels) {
      try {
        if (document.querySelector(sel)) return true;
      } catch (_) {
        // bad selector (e.g. case-insensitive flag in older browsers) — ignore
      }
    }
    return false;
  }

  async function waitForGenerationEnd() {
    const STABLE_MS = 3500;          // primary: UI confirms done + stable
    const FALLBACK_STABLE_MS = 12000; // fallback: text stable this long → done regardless of UI
    const TIMEOUT_MS = 300000;
    const POLL_MS = 500;

    const start = Date.now();
    let lastText = '';
    let lastChangedAt = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      const text = getLatestAssistantText();
      const stopVisible = !!findStopButton();
      const streaming = isStreaming();

      if (text !== lastText) {
        lastText = text;
        lastChangedAt = Date.now();
      }

      const stableFor = Date.now() - lastChangedAt;

      // Primary: framework UI says generating is done AND text settled.
      // Fires fast (3.5s) when the tab is in the foreground and re-renders normally.
      if (text && !stopVisible && !streaming && stableFor >= STABLE_MS) {
        return text;
      }

      // Fallback: in hidden tabs the framework defers re-renders so stop-button /
      // streaming-class may stay stale even after generation actually finished.
      // If text itself hasn't moved for FALLBACK_STABLE_MS we trust that and return.
      if (text && stableFor >= FALLBACK_STABLE_MS) {
        return text;
      }

      await sleep(POLL_MS);
    }
    throw new Error('Generation did not complete within 5 minutes');
  }

  async function runPrompt(prompt) {
    const beforeCount = await submitPrompt(prompt);
    await waitForGenerationStart(beforeCount);
    const output = await waitForGenerationEnd();
    if (!output) throw new Error('Empty output captured');
    return output;
  }

  // Two-phase variant for background-tab parallel mode:
  // Phase 1 (needs document focus): submit + wait for first token to appear.
  // Phase 2 (no focus needed): poll until text stabilizes.
  let pendingPhase2 = null;

  async function submitAndWaitStart(prompt) {
    const beforeCount = await submitPrompt(prompt);
    await waitForGenerationStart(beforeCount);
    pendingPhase2 = { active: true };
  }

  async function waitForOutput() {
    if (!pendingPhase2) throw new Error('No active submission to wait on');
    try {
      const output = await waitForGenerationEnd();
      if (!output) throw new Error('Empty output captured');
      return output;
    } finally {
      pendingPhase2 = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, provider: config.id });
      return;
    }
    if (msg.type === 'ENSURE_NEW_CHAT') {
      ensureNewChat()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'RUN_PROMPT') {
      runPrompt(msg.prompt)
        .then(output => sendResponse({ ok: true, output }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'SUBMIT_AND_WAIT_START') {
      submitAndWaitStart(msg.prompt)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'WAIT_FOR_OUTPUT') {
      waitForOutput()
        .then(output => sendResponse({ ok: true, output }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'PROBE_STATE') {
      try {
        sendResponse({ ok: true, state: probeState() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
      return;
    }
  });

  function probeState() {
    const inputEl = findInput();
    const sendBtn = findSendButton();
    const stopBtn = findStopButton();
    const newChatBtn = findNewChatButton();
    const messages = getAssistantMessages();
    const inputContent = inputEl
      ? (inputEl instanceof HTMLTextAreaElement ? inputEl.value : inputEl.innerText)
      : null;

    return {
      provider: config.id,
      href: window.location.href,
      hostname: window.location.hostname,
      docFocus: document.hasFocus(),
      visibility: document.visibilityState,
      activeElement: document.activeElement?.tagName ?? null,
      contentEditableCount: document.querySelectorAll('[contenteditable="true"]').length,
      textareaCount: document.querySelectorAll('textarea').length,
      input: inputEl ? {
        tag: inputEl.tagName,
        id: inputEl.id || null,
        class: inputEl.className?.toString()?.slice(0, 100) ?? null,
        isConnected: inputEl.isConnected,
        hasContent: !!inputContent,
        contentPreview: inputContent?.slice(0, 120) ?? null
      } : null,
      sendButton: sendBtn ? {
        tag: sendBtn.tagName,
        label: sendBtn.getAttribute('aria-label'),
        testId: sendBtn.getAttribute('data-test-id'),
        enabled: isButtonEnabled(sendBtn),
        class: sendBtn.className?.toString()?.slice(0, 80) ?? null
      } : null,
      stopButton: stopBtn ? {
        tag: stopBtn.tagName,
        label: stopBtn.getAttribute('aria-label')
      } : null,
      newChatButton: newChatBtn ? {
        tag: newChatBtn.tagName,
        label: newChatBtn.getAttribute('aria-label'),
        testId: newChatBtn.getAttribute('data-test-id')
      } : null,
      assistantMessageCount: messages.length,
      latestMessagePreview: messages[messages.length - 1]?.innerText?.slice(0, 200) ?? null,
      streaming: isStreaming(),
      pendingPhase2: !!pendingPhase2
    };
  }
})();
