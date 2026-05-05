// =================== State ===================

let conversation = { messages: [] };
let currentThinking = null; // DOM element for the active "thinking" bubble
let streamingBubble = null; // DOM element for in-progress Final answer

const STORAGE_KEY = 'conversation';
const THEME_KEY = 'theme';
const PROVIDERS_KEY = 'enabledProviders';
const FINAL_EDITOR_KEY = 'finalEditor';

const ALL_PROVIDERS = ['chatgpt', 'gemini', 'deepseek', 'kimi'];

const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const clearBtn = document.getElementById('clear-btn');
const copyDebugBtn = document.getElementById('copy-debug');
const themeBtn = document.getElementById('theme-btn');
const messagesEl = document.getElementById('messages');
const emptyHint = document.getElementById('empty-hint');
const providerPills = document.querySelectorAll('.provider-pill');
const finalEditorSelect = document.getElementById('final-editor');

let enabledProviders = [...ALL_PROVIDERS];
let finalEditor = 'gemini';

// =================== Init ===================

(async function init() {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY, THEME_KEY, PROVIDERS_KEY, FINAL_EDITOR_KEY
    ]);
    conversation = stored[STORAGE_KEY] ?? { messages: [] };
    const savedTheme = stored[THEME_KEY];
    applyTheme(savedTheme ?? detectSystemTheme());
    const savedProviders = stored[PROVIDERS_KEY];
    if (Array.isArray(savedProviders) && savedProviders.length >= 2) {
      enabledProviders = savedProviders.filter(p => ALL_PROVIDERS.includes(p));
    }
    const savedFinal = stored[FINAL_EDITOR_KEY];
    if (savedFinal && ALL_PROVIDERS.includes(savedFinal)) {
      finalEditor = savedFinal;
    }
    finalEditorSelect.value = finalEditor;
  } catch (_) {
    conversation = { messages: [] };
    applyTheme(detectSystemTheme());
  }
  renderProviderPills();
  renderAll();
})();

// =================== Provider toggles ===================

function renderProviderPills() {
  providerPills.forEach(pill => {
    const provider = pill.dataset.provider;
    pill.dataset.enabled = enabledProviders.includes(provider) ? 'true' : 'false';
  });
}

finalEditorSelect.addEventListener('change', async () => {
  const v = finalEditorSelect.value;
  if (!ALL_PROVIDERS.includes(v)) return;
  finalEditor = v;
  try {
    await chrome.storage.local.set({ [FINAL_EDITOR_KEY]: finalEditor });
  } catch (_) {}
});

providerPills.forEach(pill => {
  pill.addEventListener('click', async () => {
    const provider = pill.dataset.provider;
    const isEnabled = enabledProviders.includes(provider);

    if (isEnabled) {
      // Don't allow going below 2
      if (enabledProviders.length <= 2) {
        // small visual feedback — flash the pill
        pill.animate(
          [{ transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
          { duration: 180, iterations: 2 }
        );
        return;
      }
      enabledProviders = enabledProviders.filter(p => p !== provider);
    } else {
      // keep canonical order
      enabledProviders = ALL_PROVIDERS.filter(p =>
        enabledProviders.includes(p) || p === provider
      );
    }
    renderProviderPills();
    try {
      await chrome.storage.local.set({ [PROVIDERS_KEY]: enabledProviders });
    } catch (_) {}
  });
});

// =================== Theme ===================

function detectSystemTheme() {
  try {
    return window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } catch (_) {
    return 'light';
  }
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = t;
  // button label shows what it'll switch TO
  themeBtn.textContent = t === 'dark' ? '浅色' : '深色';
}

themeBtn.addEventListener('click', async () => {
  const current = document.body.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await chrome.storage.local.set({ [THEME_KEY]: next });
  } catch (_) {}
});

// Follow OS theme changes IF user hasn't set a preference yet
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', async (e) => {
    const stored = await chrome.storage.local.get(THEME_KEY);
    if (!stored[THEME_KEY]) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
} catch (_) {}

// =================== Persistence ===================

async function persist() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: conversation });
  } catch (err) {
    console.error('Persist failed:', err);
  }
}

// =================== Rendering ===================

function renderAll() {
  // remove only message bubbles, keep empty hint
  Array.from(messagesEl.children).forEach(child => {
    if (child !== emptyHint) child.remove();
  });

  if (conversation.messages.length === 0) {
    emptyHint.style.display = '';
    return;
  }
  emptyHint.style.display = 'none';

  for (const msg of conversation.messages) {
    appendMessageElement(msg);
  }
  scrollToBottom();
}

function appendMessageElement(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.role}`;

  const content = document.createElement('div');
  content.className = msg.role === 'assistant' ? 'markdown' : '';
  content.textContent = msg.content;
  el.appendChild(content);

  if (msg.role === 'assistant' && msg.rounds) {
    el.appendChild(buildRoundsDetails(msg.rounds));
  }

  messagesEl.appendChild(el);
  emptyHint.style.display = 'none';
  return el;
}

function buildRoundsDetails(rounds) {
  const details = document.createElement('details');
  details.className = 'rounds';

  const summary = document.createElement('summary');
  summary.textContent = '查看 R1 / R2 推理过程';
  details.appendChild(summary);

  if (rounds.r1) appendRoundBlock(details, 'Round 1 — independent', rounds.r1);
  if (rounds.r2) appendRoundBlock(details, 'Round 2 — cross-review', rounds.r2);

  return details;
}

function appendRoundBlock(parent, title, providerOutputs) {
  const block = document.createElement('div');
  block.className = 'round-block';

  const t = document.createElement('div');
  t.className = 'round-title';
  t.textContent = title;
  block.appendChild(t);

  for (const [provider, output] of Object.entries(providerOutputs)) {
    const item = document.createElement('div');
    item.className = 'round-item';
    item.dataset.provider = provider;

    const name = document.createElement('div');
    name.className = 'pname';
    name.textContent = provider;
    item.appendChild(name);

    const text = document.createElement('div');
    text.className = 'ptext';
    text.textContent = output;
    item.appendChild(text);

    block.appendChild(item);
  }

  parent.appendChild(block);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// =================== Thinking indicator ===================

function showThinking() {
  currentThinking = document.createElement('div');
  currentThinking.className = 'msg thinking';
  currentThinking.textContent = '正在思考...';
  messagesEl.appendChild(currentThinking);
  emptyHint.style.display = 'none';
  scrollToBottom();
}

function updateThinking(text) {
  if (currentThinking) currentThinking.textContent = text;
}

function clearThinking() {
  if (currentThinking) {
    currentThinking.remove();
    currentThinking = null;
  }
}

function showError(message) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = `出错了：${message}`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// =================== Streaming Final bubble ===================

function startStreamingBubble(text) {
  clearThinking();
  streamingBubble = document.createElement('div');
  streamingBubble.className = 'msg assistant streaming';
  const content = document.createElement('div');
  content.className = 'markdown';
  content.textContent = text;
  streamingBubble.appendChild(content);
  messagesEl.appendChild(streamingBubble);
  emptyHint.style.display = 'none';
  scrollToBottom();
}

function updateStreamingBubble(text) {
  if (!streamingBubble) return;
  const content = streamingBubble.querySelector('.markdown');
  if (content) content.textContent = text;
  // gentle scroll only if user is already near bottom (don't yank them up)
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (nearBottom) scrollToBottom();
}

function finalizeStreamingBubble(finalText, rounds) {
  if (!streamingBubble) return false;
  const content = streamingBubble.querySelector('.markdown');
  if (content) content.textContent = finalText;
  streamingBubble.classList.remove('streaming');
  if (rounds) streamingBubble.appendChild(buildRoundsDetails(rounds));
  streamingBubble = null;
  return true;
}

function removeStreamingBubble() {
  if (streamingBubble) {
    streamingBubble.remove();
    streamingBubble = null;
  }
}

// =================== Send ===================

async function send() {
  const text = promptEl.value.trim();
  if (!text) return;

  setRunning(true);

  const userMsg = { role: 'user', content: text, ts: Date.now() };
  conversation.messages.push(userMsg);
  appendMessageElement(userMsg);
  await persist();

  promptEl.value = '';
  scrollToBottom();

  showThinking();

  const history = conversation.messages
    .slice(0, -1)
    .map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'RUN_FULL_PIPELINE',
      prompt: text,
      history,
      providers: enabledProviders,
      finalEditor
    });

    clearThinking();

    if (response?.cancelled) {
      // Roll back: remove streaming bubble (if it appeared) AND user message
      removeStreamingBubble();
      conversation.messages.pop();
      removeLastMessageElement();
      await persist();
      promptEl.value = text; // restore so user can edit + resend
      return;
    }

    if (!response?.ok) {
      removeStreamingBubble();
      showError(response?.error ?? 'Pipeline returned no result');
      return;
    }

    const r1Map = {};
    for (const r of response.r1 ?? []) if (r.ok) r1Map[r.provider] = r.output;
    const r2Map = {};
    for (const r of response.r2 ?? []) if (r.ok) r2Map[r.provider] = r.output;
    const finalText = response.final?.output ?? '(final synthesis missing)';

    const assistantMsg = {
      role: 'assistant',
      content: finalText,
      ts: Date.now(),
      rounds: { r1: r1Map, r2: r2Map }
    };
    conversation.messages.push(assistantMsg);

    // If streaming already created a bubble, finalize it in-place;
    // otherwise (no partials arrived) append a fresh bubble.
    const finalized = finalizeStreamingBubble(finalText, assistantMsg.rounds);
    if (!finalized) {
      appendMessageElement(assistantMsg);
    }

    await persist();
    scrollToBottom();
  } catch (err) {
    clearThinking();
    showError(err.message ?? String(err));
  } finally {
    setRunning(false);
    promptEl.focus();
  }
}

function removeLastMessageElement() {
  const all = messagesEl.querySelectorAll('.msg');
  if (all.length > 0) all[all.length - 1].remove();
  if (conversation.messages.length === 0) emptyHint.style.display = '';
}

function setRunning(running) {
  promptEl.disabled = running;
  sendBtn.disabled = running;
  sendBtn.hidden = running;
  stopBtn.hidden = !running;
}

async function cancelPipeline() {
  stopBtn.disabled = true;
  stopBtn.textContent = '取消中...';
  try {
    await chrome.runtime.sendMessage({ type: 'CANCEL_PIPELINE' });
  } catch (_) {}
  // The send() promise will resolve with response.cancelled === true,
  // which handles cleanup. We just reset the button label here.
  setTimeout(() => {
    stopBtn.disabled = false;
    stopBtn.textContent = '停止';
  }, 500);
}

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', cancelPipeline);

// Cmd/Ctrl+Enter or plain Enter sends; Shift+Enter inserts newline
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!sendBtn.disabled) send();
  }
});

// =================== Live progress (PROVIDER_UPDATE) ===================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PROVIDER_UPDATE') return;
  const rawRound = msg.round ?? 'r1';
  const round = rawRound.toUpperCase();
  const subStage = msg.stage ?? msg.status;
  const provider = msg.provider;

  // Final stage: stream partial output into a live assistant bubble,
  // replacing the thinking indicator.
  if (rawRound === 'final' && typeof msg.partialOutput === 'string' && msg.partialOutput) {
    if (!streamingBubble) {
      startStreamingBubble(msg.partialOutput);
    } else {
      updateStreamingBubble(msg.partialOutput);
    }
    return;
  }

  if (msg.status === 'running') {
    updateThinking(`[${round}] ${provider} · ${subStage}`);
  } else if (msg.status === 'done') {
    const sec = msg.elapsedMs ? ` (${(msg.elapsedMs/1000).toFixed(1)}s)` : '';
    updateThinking(`[${round}] ${provider} done${sec}`);
  } else if (msg.status === 'failed') {
    updateThinking(`[${round}] ${provider} failed`);
  }
});

// =================== Clear conversation ===================

clearBtn.addEventListener('click', async () => {
  if (conversation.messages.length === 0) return;
  if (!confirm('清空当前对话？这会删除所有消息。')) return;
  conversation = { messages: [] };
  await persist();
  renderAll();
});

// =================== Debug bundle ===================

copyDebugBtn.addEventListener('click', copyDebug);

async function copyDebug() {
  const original = copyDebugBtn.textContent;
  copyDebugBtn.disabled = true;
  copyDebugBtn.textContent = 'Collecting...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'COLLECT_DEBUG' });
    if (!response?.ok) throw new Error(response?.error ?? 'collection failed');

    const md = formatDebugMarkdown(response.data);
    await writeToClipboard(md);

    copyDebugBtn.textContent = '✓ Copied';
    setTimeout(() => { copyDebugBtn.textContent = original; }, 2500);
  } catch (err) {
    copyDebugBtn.textContent = `Err: ${err.message}`;
    setTimeout(() => { copyDebugBtn.textContent = original; }, 4000);
  } finally {
    copyDebugBtn.disabled = false;
  }
}

async function writeToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function formatDebugMarkdown(d) {
  const L = [];
  L.push('# Multi AI Orchestrator — Debug bundle');
  L.push('');
  L.push(`- Time: ${d.timestamp}`);
  L.push(`- Extension: v${d.extension}`);
  L.push(`- UA: ${d.userAgent}`);
  L.push(`- Conversation turns: ${conversation.messages.length}`);
  L.push('');

  L.push(`## Recent errors (${d.errors.length})`);
  if (d.errors.length === 0) {
    L.push('_(none recorded)_');
  } else {
    for (const e of d.errors) {
      L.push(`- \`${e.ts}\` **${e.provider}** @ ${e.stage}: ${e.message}`);
    }
  }
  L.push('');

  L.push('## Provider states');
  L.push('');
  for (const [provider, s] of Object.entries(d.providerStates)) {
    L.push(`### ${provider}`);
    L.push('');
    if (!s.tabInfo) L.push('- **Tab:** _not opened_');
    else if (s.tabInfo.error) L.push(`- **Tab:** error \`${s.tabInfo.error}\``);
    else {
      L.push(`- **Tab:** ${s.tabInfo.url}`);
      L.push(`  - status: \`${s.tabInfo.status}\`, active: \`${s.tabInfo.active}\``);
    }
    if (s.perStage && Object.keys(s.perStage).length > 0) {
      for (const [stage, info] of Object.entries(s.perStage)) {
        L.push(`- **${stage.toUpperCase()}:** stage=${info.lastStage ?? '?'}` +
          (info.lastResult
            ? ` · ${info.lastResult.status}` +
              (info.lastResult.elapsedMs != null ? ` (${(info.lastResult.elapsedMs/1000).toFixed(1)}s)` : '')
            : ''));
        if (info.lastResult?.error) L.push(`  - error: \`${info.lastResult.error}\``);
      }
    }
    if (s.probe?.ok) {
      const p = s.probe.state;
      L.push(`- **Probe:** docFocus=${p.docFocus}, vis=${p.visibility}, msgCount=${p.assistantMessageCount}, streaming=${p.streaming}`);
    } else if (s.probe) {
      L.push(`- **Probe:** error \`${s.probe.error ?? 'unknown'}\``);
    }
    L.push('');
  }

  return L.join('\n');
}
