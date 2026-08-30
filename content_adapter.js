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
        'button[aria-label*="终止" i]',
        'button[class*="stop" i]',
        'button[class*="Stop" i]',
        'div[role="button"][aria-label*="停止"]',
        'div[role="button"][class*="stop" i]',
        '[data-testid*="stop" i]'
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

  // CRITICAL: filter out nested sub-frames. With all_frames: true, content
  // scripts inject into EVERY frame matching the URL pattern — including
  // anti-bot / sandbox sub-frames the AI sites add inside themselves
  // (e.g. Gemini's `gemini.google.com/_/bscframe`). If those sub-frames
  // register as `provider=gemini`, they overwrite the real iframe's frameId
  // in SW and the pipeline starts talking to the wrong frame.
  //
  // Only register if we're a DIRECT child of the top-level page (i.e. one
  // of the 4 grid.html iframes), or in a top-level tab (direct browsing).
  const inIframe = window.top !== window.self;
  let isDirectChildOfTop = true;
  if (inIframe) {
    try {
      isDirectChildOfTop = window.parent === window.top;
    } catch (_) {
      isDirectChildOfTop = false;
    }
  }

  if (inIframe && !isDirectChildOfTop) {
    // We're a nested sub-frame inside a provider iframe. Don't register,
    // don't run autoInit, don't expose handlers — let the real provider
    // iframe own the (tab, provider) mapping.
    return;
  }

  try {
    chrome.runtime.sendMessage({
      type: 'CONTENT_SCRIPT_REGISTER',
      provider: config.id,
      inIframe
    }).catch(() => {});
  } catch (_) {}

  // =================== Auto-init per provider ===================
  // Runs once on content-script load. Handles initial-state quirks (cookie
  // banners, temp-chat activation) so each iframe is "clean" before any
  // pipeline message arrives.

  function findCookieAcceptButton() {
    const labels = ['接受全部', 'Accept all', '全部接受', '同意全部', '我同意'];
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    return candidates.find(b => {
      const text = (b.textContent ?? '').trim();
      return labels.some(l => text === l || text.includes(l));
    }) ?? null;
  }

  async function autoInit() {
    // Let the page do its initial render first
    await sleep(1200);

    if (config.id === 'deepseek') {
      // Auto-dismiss the cookie consent modal so it doesn't block input
      try {
        const btn = await waitUntil(
          () => findCookieAcceptButton(),
          { timeoutMs: 5000, intervalMs: 400 }
        );
        if (btn) robustClick(btn);
      } catch (_) { /* no banner — fine */ }
    }

    if (config.id === 'gemini') {
      // Auto-enter temporary chat so the iframe doesn't sit on the home page
      try { await ensureNewChat(); } catch (_) {}
    }

    // ChatGPT: starts in temp chat via ?temporary-chat=true URL — nothing to do
    // Kimi: no banners or special init needed
  }

  autoInit();

  // Exposed for SW-driven polling. SW calls this via chrome.scripting.executeScript
  // every poll tick — that synchronous invocation forces the tab's event loop to
  // run, which keeps framework re-renders flushing even when the tab is hidden.
  window.__multiAIPollState = function () {
    try {
      const messages = getAssistantMessages();
      const last = messages[messages.length - 1];

      // For ChatGPT reasoning models (o-series / "Thought for X"), the
      // assistant bubble contains BOTH a collapsed reasoning panel AND the
      // final answer in separate children. domToMarkdown on the outer bubble
      // gets confused by the reasoning element's collapsed/short text. Prefer
      // a dedicated answer container when we can find one.
      let answerEl = last;
      if (last) {
        const md =
          last.querySelector('.markdown.prose') ||
          last.querySelector('div[class*="markdown"][class*="prose"]') ||
          last.querySelector('.markdown');
        if (md) answerEl = md;
      }
      const text = answerEl ? domToMarkdown(answerEl).trim() : '';

      // Detect reasoning-in-progress. For ChatGPT's o-series models, the
      // "Thinking..." / "Thought for X" indicator lives in a sibling DOM
      // node of the assistant message bubble (NOT inside it), so we have
      // to search document-wide. While that indicator is present and the
      // answer container is still tiny, treat the state as streaming so
      // polling keeps waiting through the post-thinking render delay.
      let reasoning = false;
      let analyzingImages = false;
      const REASONING_PATTERNS = /Thinking\.{1,3}|Thought for\s|思考了|正在思考|Reasoning\.{1,3}/i;
      // "正在分析 N 幅图片" / "Analyzing image" — ChatGPT pre-answer state
      // when processing uploads. Distinct from reasoning: this state can hang
      // indefinitely if the vision backend errors, so the SW polls with a
      // SHORTER patience budget when this flag is set.
      const ANALYZING_PATTERNS = /正在分析.{0,8}(幅|张).{0,4}图|分析图片中|Analyzing image|Analyzing the image|Looking at .{0,20}image/i;
      try {
        const turn = last?.closest('article, [class*="turn"], [class*="message"]') || last;
        const scope = turn?.parentElement || document;
        const scopeText = scope?.textContent?.slice(0, 4000) || '';
        if (REASONING_PATTERNS.test(scopeText)) {
          const answerLen = (answerEl?.textContent?.length || 0);
          if (answerLen < 200) reasoning = true;
        }
        if (ANALYZING_PATTERNS.test(scopeText)) {
          const answerLen = (answerEl?.textContent?.length || 0);
          if (answerLen < 200) analyzingImages = true;
        }
      } catch (_) {}

      // ChatGPT-specific authoritative "done" signal. The assistant message
      // bubble carries data-message-status with values like:
      //   "streaming" — still generating
      //   "finished_successfully" — terminal, done
      //   "finished_partial_completion" — terminal, truncated but done
      //   "in_progress" — older clients use this for streaming
      // Reasoning models don't set this attribute at all — it stays null.
      const messageStatus = last?.getAttribute?.('data-message-status') ?? null;

      return {
        provider: config.id,
        text,
        stopVisible: !!findStopButton(),
        streaming: isStreaming() || reasoning || analyzingImages,
        messageCount: messages.length,
        messageStatus,
        reasoning,
        analyzingImages,
        fullTextLen: last?.textContent?.length ?? 0,
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
    const last = msgs[msgs.length - 1];
    if (!last) return '';
    // domToMarkdown preserves structure (lists, bold, links, code) that
    // innerText silently strips — that's what was making numbered lists
    // collapse to "1. 1. 1." and bold disappear when piped to next round.
    return domToMarkdown(last).trim();
  }

  // Lightweight HTML→Markdown converter. Walks the DOM and emits markdown
  // tokens for the elements assistant UIs actually use.
  function domToMarkdown(root) {
    if (!root) return '';

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      switch (tag) {
        case 'br': return '\n';
        case 'hr': return '\n---\n';
        case 'p':  return walkChildren(node) + '\n\n';
        case 'h1': return '\n# '   + walkChildren(node).trim() + '\n\n';
        case 'h2': return '\n## '  + walkChildren(node).trim() + '\n\n';
        case 'h3': return '\n### ' + walkChildren(node).trim() + '\n\n';
        case 'h4': return '\n#### ' + walkChildren(node).trim() + '\n\n';
        case 'h5': return '\n##### ' + walkChildren(node).trim() + '\n\n';
        case 'h6': return '\n###### ' + walkChildren(node).trim() + '\n\n';
        case 'strong': case 'b':
          return '**' + walkChildren(node) + '**';
        case 'em': case 'i':
          return '*' + walkChildren(node) + '*';
        case 'del': case 's': case 'strike':
          return '~~' + walkChildren(node) + '~~';
        case 'a': {
          const href = node.getAttribute('href') || '';
          const text = walkChildren(node);
          return href && href !== text ? `[${text}](${href})` : text;
        }
        case 'code': {
          if (node.parentElement && node.parentElement.tagName === 'PRE') {
            return node.textContent;
          }
          return '`' + node.textContent + '`';
        }
        case 'pre': {
          const code = node.querySelector('code');
          const text = (code ? code.textContent : node.textContent).replace(/\n+$/, '');
          return '\n```\n' + text + '\n```\n\n';
        }
        case 'ol': {
          const items = Array.from(node.children).filter(c => c.tagName === 'LI');
          return '\n' + items.map((li, i) =>
            (i + 1) + '. ' + walkChildren(li).trim().replace(/\n/g, '\n   ')
          ).join('\n') + '\n\n';
        }
        case 'ul': {
          const items = Array.from(node.children).filter(c => c.tagName === 'LI');
          return '\n' + items.map(li =>
            '- ' + walkChildren(li).trim().replace(/\n/g, '\n  ')
          ).join('\n') + '\n\n';
        }
        case 'li': return walkChildren(node);
        case 'blockquote':
          return '\n' + walkChildren(node).trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (rows.length === 0) return '';
          const cells = rows.map(tr =>
            Array.from(tr.children).map(td => td.textContent.trim().replace(/\|/g, '\\|'))
          );
          const cols = Math.max(...cells.map(r => r.length));
          const lines = [
            '| ' + cells[0].join(' | ') + ' |',
            '|' + Array(cols).fill('---').join('|') + '|',
            ...cells.slice(1).map(r => '| ' + r.join(' | ') + ' |')
          ];
          return '\n' + lines.join('\n') + '\n\n';
        }
        case 'script': case 'style': case 'noscript':
          return '';
        default:
          return walkChildren(node);
      }
    };

    const walkChildren = (node) => {
      let out = '';
      for (const c of node.childNodes) out += walk(c);
      return out;
    };

    return walk(root)
      .replace(/[ \t]+\n/g, '\n')      // trim trailing spaces on each line
      .replace(/\n{3,}/g, '\n\n');     // collapse 3+ blank lines
  }

  function setInputValue(input, value) {
    // In iframe contexts document.hasFocus() may be false without explicit
    // window.focus(), and that breaks execCommand for Quill (Gemini).
    try { window.focus(); } catch (_) {}
    input.focus();

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // Whitespace-tolerant: editors normalize newlines into block elements so
    // the readback will have different whitespace than what we inserted.
    const wantedKey = value.replace(/\s+/g, '').slice(0, Math.min(20, value.length));
    const has = () => {
      const compact = ((input.innerText ?? '') + (input.textContent ?? ''))
        .replace(/\s+/g, '');
      return compact.includes(wantedKey);
    };

    // 1) execCommand insertText — best for Quill/Lexical/ProseMirror when focused
    try { document.execCommand('insertText', false, value); } catch (_) {}
    if (has()) return;

    // 2) Paste event — works for some Lexical builds, less reliable for Quill
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      input.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (_) {}
    if (has()) return;

    // 3) beforeinput event (Quill in iframe-no-focus case often only honors this)
    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: value,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
      input.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: value,
        bubbles: true,
        composed: true
      }));
    } catch (_) {}
  }

  async function ensureNewChat() {
    if (config.id === 'chatgpt') return; // ?temporary-chat=true handles it via URL

    // Gemini specifically: gemini.google.com/app auto-redirects to the most
    // recent conversation. Clicking "临时对话" while inside a saved conversation
    // doesn't put THIS chat into temp mode. We have to first click "新对话"
    // to leave the saved conversation, then click "临时对话". Tight 1.5s cap
    // — if the new-chat button isn't visible by then, we're already on the
    // home page and don't need it.
    if (config.id === 'gemini') {
      const newChat = await waitUntil(
        () => {
          const b = document.querySelector('[data-test-id="new-chat-button"]');
          return isButtonEnabled(b) ? b : null;
        },
        { timeoutMs: 1500, intervalMs: 200 }
      ).catch(() => null);
      if (newChat) {
        robustClick(newChat);
        await sleep(400);
      }
    }

    // Now look for the priority new-chat-style button. For Gemini that's
    // the temp-chat-button — but in iframe context Gemini hides this
    // button entirely (anti-iframe), so waiting 10s for it is pure waste
    // every reload (3+ rounds × ~10s = 30s+ per pipeline). Tight 2s cap:
    // if the button doesn't appear by then, autoInit moves on without it.
    const btn = await waitUntil(
      () => {
        const b = findNewChatButton();
        return isButtonEnabled(b) ? b : null;
      },
      { timeoutMs: 2000, intervalMs: 200 }
    ).catch(() => null);

    if (!btn) return;
    robustClick(btn);
    await sleep(500);
  }

  function pressEnter(input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Ctrl+Enter / Cmd+Enter — Gemini's Quill swallows plain Enter as
  // newline (same as Shift+Enter); the actual submit shortcut is the
  // modifier variant. Use this as a third-tier fallback after click + Enter.
  function pressCtrlEnter(input) {
    const opts = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      ctrlKey: true, metaKey: true,
      bubbles: true, cancelable: true
    };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function submitPrompt(prompt, skipInput) {
    let input = await waitUntil(
      () => findInput(),
      { timeoutMs: 30000, intervalMs: 300 }
    );
    const beforeCount = getAssistantMessages().length;

    // Whitespace-tolerant verification. Editors like Lexical/Quill render text
    // into <p> blocks, so what came in as "原始问题：\nAI..." reads back as
    // "原始问题：\n\nAI..." via innerText. Strip whitespace from both sides
    // before comparing so we don't fail-fast on a successful injection.
    const stripWS = (s) => (s ?? '').replace(/\s+/g, '');
    const promptCompact = stripWS(prompt);
    // First ~20 non-whitespace chars are enough to confirm the prompt landed.
    const wantedKey = promptCompact.slice(0, Math.min(20, promptCompact.length));
    const readText = (el) => el instanceof HTMLTextAreaElement
      ? el.value
      : (el.innerText ?? '');
    const inputContains = (el) => stripWS(readText(el)).includes(wantedKey);

    if (!skipInput) {
      setInputValue(input, prompt);
      await sleep(300);

      if (!inputContains(input)) {
        const fresh = findInput();
        if (fresh && fresh !== input) {
          input = fresh;
          setInputValue(input, prompt);
          await sleep(300);
        }
      }

      if (!inputContains(input)) {
        const inputType = input.tagName + (input instanceof HTMLTextAreaElement ? '/textarea' : '/contenteditable');
        const readback = readText(input).slice(0, 30).replace(/\s/g, ' ');
        throw new Error(
          `Prompt failed to enter input — all 3 methods rejected. ` +
          `input=${inputType} docFocus=${document.hasFocus()} ` +
          `wantedKey="${wantedKey.slice(0, 20)}" readback="${readback}"`
        );
      }
    } else {
      // SW already injected (e.g. via Quill's API for Gemini). Verify presence,
      // wait briefly if needed for the framework to propagate it.
      if (!inputContains(input)) {
        await sleep(400);
      }
      if (!inputContains(input)) {
        const readback = readText(input).slice(0, 30).replace(/\s/g, ' ');
        throw new Error(
          `skipInput set but Quill injection didn't take. ` +
          `docFocus=${document.hasFocus()} ` +
          `wantedKey="${wantedKey.slice(0, 20)}" readback="${readback}"`
        );
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

    // Detached fallback chain. If the click didn't fire submission, escalate:
    //   T+1.2s: plain Enter (works for most providers)
    //   T+3.0s: Ctrl+Enter / Cmd+Enter (Gemini Quill swallows plain Enter
    //           as newline; modifier+Enter is its actual submit shortcut)
    // Awaiting these would let SPA providers (DeepSeek) tear down the content
    // script mid-await; SW-side polling catches "no text appeared" anyway.
    const inputRef = input;
    setTimeout(() => {
      try {
        if (getAssistantMessages().length === beforeCount) {
          pressEnter(inputRef);
        }
      } catch (_) {}
    }, 1200);
    setTimeout(() => {
      try {
        if (getAssistantMessages().length === beforeCount) {
          pressCtrlEnter(inputRef);
        }
      } catch (_) {}
    }, 3000);

    return beforeCount;
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

  // "Fire and return" — only await submitPrompt (which inserts text + clicks
  // send + verifies input). DON'T await for first token here: providers like
  // DeepSeek do SPA nav immediately on send, which kills the content script
  // mid-await and closes the message channel before sendResponse fires.
  // SW-side pollFrameUntilStable handles "no text appeared" via its 90s
  // first-text timeout.
  async function submitAndWaitStart(prompt, skipInput) {
    await submitPrompt(prompt, skipInput);
  }

  // =================== Image attachment (iPhone relay) ===================
  // Used by the Telegram→ChatGPT→WhatsApp relay path. Converts base64 images
  // to File objects, dispatches a paste event with them on the input, then
  // waits for ChatGPT to show upload thumbnails before submitting. This is
  // ChatGPT-specific for now (the relay only targets ChatGPT).

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  // Find ChatGPT's hidden <input type="file"> that the "Add photos" button
  // wires up. Pumping files directly through this input is far more reliable
  // than synthesizing a paste event — paste handlers in modern Lexical-based
  // composers often ignore programmatic ClipboardEvent.
  function findChatgptFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    // Prefer one that explicitly accepts images.
    return (
      inputs.find(i => /image/i.test(i.accept || '')) ||
      inputs[0] ||
      null
    );
  }

  async function attachImages(images) {
    const editor = await waitUntil(
      () => findInput(),
      { timeoutMs: 30000, intervalMs: 300 }
    );

    try { window.focus(); } catch (_) {}
    editor.focus();
    await sleep(150);

    const files = images.map(img => {
      const blob = base64ToBlob(img.base64, img.type);
      return new File([blob], img.name, { type: img.type });
    });

    let strategy = 'none';

    // Strategy 1 (preferred): set files directly on the hidden file input
    // using React's native setter (bypasses React's synthetic value tracking
    // that would otherwise ignore plain assignment), then fire BOTH change
    // and input events. This is the same pattern testing libraries use.
    const fileInput = findChatgptFileInput();
    if (fileInput) {
      try {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        // React's onChange wraps the native setter; setting input.files = ...
        // directly is silently dropped on some React versions because React
        // tracks the value separately. Use the prototype setter to be safe.
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'files'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(fileInput, dt.files);
        } else {
          fileInput.files = dt.files;
        }
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        strategy = 'file-input';
      } catch (e) {
        strategy = 'file-input-failed:' + (e.message ?? e);
      }
    }

    // Strategy 2 (drop event): some ChatGPT versions wire the file picker
    // through a drag-drop listener on the composer. Fire a real DragEvent
    // with files in dataTransfer.
    if (strategy !== 'file-input') {
      try {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const dropTarget = editor.closest('form') || editor;
        dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }));
        if (strategy === 'none') strategy = 'drop';
      } catch (_) {}
    }

    // Strategy 3 (paste fallback): paste event with files on the contenteditable.
    if (strategy === 'none' || /failed/.test(strategy)) {
      try {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        editor.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true
        }));
        strategy = 'paste';
      } catch (_) {}
    }

    // Wait for ChatGPT to actually finish uploading the attachments BEFORE we
    // click send. The old check ("send button becomes enabled") was unreliable
    // because the send button starts enabled (prompt text is already in the
    // box) — it would return immediately and we'd submit before the upload
    // pipeline registered any images, producing the dreaded
    //   "正在分析 [empty] 幅图片"
    // hang on the OpenAI side.
    //
    // Real signal: thumbnail tiles appear in the composer form. We wait for
    // N tiles (one per file) AND for any "uploading" spinner inside them
    // to disappear.
    const expectedCount = files.length;
    const composer =
      editor.closest('form') ||
      editor.closest('[class*="composer"]') ||
      editor.parentElement;

    function countAttachmentTiles() {
      if (!composer) return 0;
      // ChatGPT renders each upload as a tile that contains either an <img>
      // preview (image files) or a file icon. Count the most reliable union:
      //   - <img> with blob: / data: src (= locally previewed)
      //   - elements with data-testid containing "attachment" or "file"
      const imgs = composer.querySelectorAll('img');
      let blobImgs = 0;
      for (const img of imgs) {
        const src = img.getAttribute('src') || img.currentSrc || '';
        if (src.startsWith('blob:') || src.startsWith('data:')) blobImgs++;
      }
      const tagged = composer.querySelectorAll(
        '[data-testid*="attachment" i], [data-testid*="file" i]'
      ).length;
      return Math.max(blobImgs, tagged);
    }

    function anyTileStillUploading() {
      if (!composer) return false;
      // ChatGPT shows a spinner or "uploading" aria-label while the file is
      // being POSTed to OpenAI's CDN. Heuristic: any spinner / progressbar in
      // the composer means we're not ready.
      return !!composer.querySelector(
        '[role="progressbar"], [aria-label*="upload" i][aria-busy="true"], ' +
        '[class*="spinner" i], svg[class*="spin" i]'
      );
    }

    // Stage 1: tiles appear.
    const tilesAppeared = await waitUntil(
      () => countAttachmentTiles() >= expectedCount ? true : null,
      { timeoutMs: 30000, intervalMs: 300 }
    ).catch(() => null);

    if (!tilesAppeared) {
      const seen = countAttachmentTiles();
      // HARD fail: submitting now would result in ChatGPT showing
      // "正在分析  幅图片" forever (empty image count). Throw so the SW's
      // retry loop reopens the tab and tries again with a fresh composer.
      throw new Error(`attach failed: only ${seen}/${expectedCount} tiles appeared after 30s (strategy=${strategy})`);
    } else {
      // Stage 2: spinners clear.
      await waitUntil(
        () => !anyTileStillUploading() ? true : null,
        { timeoutMs: 90000, intervalMs: 500 }
      ).catch(() => null);
      // Small settle delay so React commits the final attachment list before
      // we click send.
      await sleep(400);
      strategy += `:tiles=${countAttachmentTiles()}/${expectedCount}`;
    }

    return { count: files.length, strategy };
  }

  async function submitWithAttachments(prompt, images) {
    if (config.id !== 'chatgpt') {
      throw new Error(`attachments not supported for provider ${config.id}`);
    }
    let attachInfo = null;
    if (Array.isArray(images) && images.length > 0) {
      attachInfo = await attachImages(images);
      // intentionally non-fatal — proceed to submit even if image upload is
      // ambiguous, so we always at least get the prompt through.
    }
    await submitPrompt(prompt, /*skipInput=*/false);
    return attachInfo;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUBMIT_AND_WAIT_START') {
      submitAndWaitStart(msg.prompt, msg.skipInput)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'SUBMIT_WITH_ATTACHMENTS') {
      submitWithAttachments(msg.prompt, msg.images ?? [])
        .then(info => sendResponse({ ok: true, attach: info }))
        .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
      return true;
    }
    if (msg.type === 'RESET_TO_START' && typeof msg.url === 'string') {
      // SW asks us to navigate to the start URL for a fresh chat.
      // Defer so sendResponse can fire before the channel closes due to nav.
      sendResponse({ ok: true });
      setTimeout(() => {
        try { window.location.replace(msg.url); }
        catch (_) { window.location.href = msg.url; }
      }, 50);
      return false;
    }
    if (msg.type === 'PROBE_STATE') {
      try {
        sendResponse({ ok: true, state: probeState() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
      return;
    }
    if (msg.type === 'REREGISTER') {
      // SW restarted and lost frame map — re-announce ourselves so
      // providerFrames repopulates without reloading the iframe.
      try {
        chrome.runtime.sendMessage({
          type: 'CONTENT_SCRIPT_REGISTER',
          provider: config.id,
          inIframe
        }).catch(() => {});
      } catch (_) {}
      sendResponse({ ok: true, provider: config.id });
      return false;
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
      // Gemini-specific: dump which temp-chat / new-chat selectors match,
      // so we can tell whether autoInit's ensureNewChat is actually finding
      // the temporary-chat button and clicking it (i.e., is Gemini still
      // saving every conversation to history?).
      geminiTempChatHints: config.id !== 'gemini' ? null : {
        tempBtnByTestId: !!document.querySelector('[data-test-id="temp-chat-button"]'),
        tempBtnByAriaCN: !!document.querySelector('button[aria-label="临时对话"]'),
        tempBtnByAriaEN: !!document.querySelector('button[aria-label*="Temporary" i]'),
        newBtnByTestId: !!document.querySelector('[data-test-id="new-chat-button"]'),
        urlHasChatId: /\/app\/[a-z0-9]+/i.test(window.location.pathname),
        // Sample first few aria-labels to spot what's around
        sampleLabels: Array.from(document.querySelectorAll('button[aria-label],[role="button"][aria-label]'))
          .slice(0, 12)
          .map(b => b.getAttribute('aria-label')?.slice(0, 30))
          .filter(Boolean)
      },
      assistantMessageCount: messages.length,
      latestMessagePreview: messages[messages.length - 1]?.innerText?.slice(0, 200) ?? null,
      streaming: isStreaming()
    };
  }
})();
