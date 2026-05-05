// =================== State ===================

let conversation = { messages: [] };
let currentThinking = null;   // active "thinking" bubble
let streamingBubble = null;   // in-progress Final answer bubble
let currentUserBubble = null; // user bubble of the message currently being processed
let pipelineRunning = false;
const messageQueue = [];      // [{ text, bubbleEl }] queued during a run

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
  markRegenEligible();
  scrollToBottom();
}

function appendMessageElement(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.role}`;

  const content = document.createElement('div');
  if (msg.role === 'assistant') {
    content.className = 'markdown';
    content.innerHTML = renderMarkdown(msg.content);
  } else {
    content.textContent = msg.content;
  }
  el.appendChild(content);

  if (msg.role === 'assistant' && msg.rounds) {
    el.appendChild(buildRoundsDetails(msg.rounds));
  }

  attachToolbar(el, msg);

  insertActive(el);
  emptyHint.style.display = 'none';
  markRegenEligible();
  return el;
}

// =================== Hover toolbar (edit / regenerate) ===================

const ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2-9 9-3 1 1-3 9-9z"/><path d="M10.5 3.5l2 2"/></svg>';
const ICON_REGEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8a6 6 0 1 1-1.76-4.24"/><polyline points="14 2 14 6 10 6"/></svg>';

function attachToolbar(bubbleEl, msg) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';

  if (msg.role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.title = '编辑这条消息（会丢弃后续所有回答并重新生成）';
    editBtn.innerHTML = ICON_EDIT;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditing(bubbleEl, msg);
    });
    tools.appendChild(editBtn);
  } else if (msg.role === 'assistant') {
    const regenBtn = document.createElement('button');
    regenBtn.title = '重新生成这条回答';
    regenBtn.innerHTML = ICON_REGEN;
    regenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerateLastAssistant();
    });
    tools.appendChild(regenBtn);
  }

  bubbleEl.appendChild(tools);
}

// Hide regenerate toolbar on assistant bubbles that aren't the latest one.
// Eligible: an assistant with no later user msg (queued bubbles don't count).
function markRegenEligible() {
  const all = Array.from(messagesEl.querySelectorAll('.msg'));
  let lastAssistantEl = null;
  for (const el of all) {
    if (el.classList.contains('user') && !el.classList.contains('queued')) {
      lastAssistantEl = null;
    } else if (el.classList.contains('assistant') && !el.classList.contains('streaming')) {
      lastAssistantEl = el;
    }
  }
  messagesEl.querySelectorAll('.msg.assistant .msg-tools').forEach(t => {
    t.style.display = (t.parentElement === lastAssistantEl) ? '' : 'none';
  });
}

// =================== Edit user message ===================

function startEditing(bubbleEl, msg) {
  if (pipelineRunning) return;
  bubbleEl.classList.add('editing');

  const editor = document.createElement('div');
  editor.className = 'edit-area';

  const textarea = document.createElement('textarea');
  textarea.value = msg.content;
  textarea.rows = Math.max(2, Math.min(8, msg.content.split('\n').length + 1));

  const btnRow = document.createElement('div');
  btnRow.className = 'edit-buttons';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel';
  cancelBtn.textContent = '取消';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'edit-save';
  saveBtn.textContent = '保存重发';
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);

  editor.appendChild(textarea);
  editor.appendChild(btnRow);
  bubbleEl.appendChild(editor);

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const cleanup = () => {
    editor.remove();
    bubbleEl.classList.remove('editing');
  };

  cancelBtn.addEventListener('click', cleanup);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      saveBtn.click();
    }
  });

  saveBtn.addEventListener('click', async () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    const idx = conversation.messages.indexOf(msg);
    if (idx < 0) { cleanup(); return; }
    cleanup();

    // Drop this user msg and ALL subsequent (assistant + later turns)
    conversation.messages = conversation.messages.slice(0, idx);
    await persist();
    renderAll();

    if (pipelineRunning) {
      enqueueMessage(newText);
    } else {
      await processMessage(newText);
      await drainQueue();
    }
  });
}

// =================== Regenerate last assistant ===================

async function regenerateLastAssistant() {
  if (pipelineRunning) return;

  let assistantIdx = -1;
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    if (conversation.messages[i].role === 'assistant') { assistantIdx = i; break; }
  }
  if (assistantIdx < 1) return;
  const userMsg = conversation.messages[assistantIdx - 1];
  if (!userMsg || userMsg.role !== 'user') return;

  // Drop the assistant + anything after, keep the user msg
  conversation.messages = conversation.messages.slice(0, assistantIdx);
  await persist();
  renderAll();

  // Run pipeline using existing user msg (don't push a new one)
  await processMessage(userMsg.content, null, /*skipPushUser=*/true);
  await drainQueue();
}

// Insert "active" content (just-sent user msg, thinking, streaming, finalized
// assistant) BEFORE any queued user bubbles, so the queue stays at the bottom.
function insertActive(el) {
  const firstQueued = messagesEl.querySelector('.msg.user.queued');
  if (firstQueued) {
    messagesEl.insertBefore(el, firstQueued);
  } else {
    messagesEl.appendChild(el);
  }
}

// =================== Minimal markdown renderer ===================

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(src) {
  if (!src) return '';
  let s = String(src);

  // 1. Pull out fenced code blocks + inline code BEFORE escaping, so their
  //    contents survive the rest of the rules untouched.
  const fenced = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fenced.push({ lang, code });
    return `CB${fenced.length - 1}`;
  });
  const inline = [];
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => {
    inline.push(code);
    return `IC${inline.length - 1}`;
  });

  // 2. Escape everything else
  s = escapeHtml(s);

  // 3. Block elements
  // Setext-style headers (text on one line, === or --- on next)
  s = s.replace(/^(.+)\n=+\s*$/gm, '<h1>$1</h1>');
  s = s.replace(/^(.+)\n-+\s*$/gm, '<h2>$1</h2>');
  // ATX-style headers
  s = s.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  s = s.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^[-*_]{3,}\s*$/gm, '<hr>');

  // Fallback: when models drop the `# ` prefix on our prescribed Final
  // section labels, still treat those bare lines as H1 headings.
  const FINAL_SECTIONS = [
    '最终结论', '综合答案',
    '三个模型的主要共识', '主要分歧与裁决',
    '可执行方案', '仍需验证的信息'
  ];
  const finalSectionRe = new RegExp(
    '^\\s*(' + FINAL_SECTIONS.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*$',
    'gm'
  );
  s = s.replace(finalSectionRe, '<h1>$1</h1>');
  s = mdProcessLists(s);
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

  // 4. Inline elements
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  // 5. Wrap loose blocks in <p> (skip lines that are already block-level)
  s = s.split(/\n{2,}/).map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol|pre|blockquote|hr|p)\b/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).filter(b => b).join('\n');

  // 6. Restore code (escaping at this stage so HTML inside is safe)
  s = s.replace(/IC(\d+)/g, (_, i) =>
    `<code>${escapeHtml(inline[+i])}</code>`);
  s = s.replace(/CB(\d+)/g, (_, i) => {
    const { lang, code } = fenced[+i];
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`;
  });

  return s;
}

function mdProcessLists(s) {
  const lines = s.split('\n');
  const out = [];
  let listType = null;
  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      out.push(`<${listType}>${buffer.join('')}</${listType}>`);
      buffer = [];
    }
    listType = null;
  };
  for (const line of lines) {
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul) {
      if (listType !== 'ul') flush();
      listType = 'ul';
      buffer.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listType !== 'ol') flush();
      listType = 'ol';
      buffer.push(`<li>${ol[1]}</li>`);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
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
    text.className = 'ptext markdown';
    text.innerHTML = renderMarkdown(output);
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
  insertActive(currentThinking);
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
  content.innerHTML = renderMarkdown(text);
  streamingBubble.appendChild(content);
  insertActive(streamingBubble);
  emptyHint.style.display = 'none';
  scrollToBottom();
}

function updateStreamingBubble(text) {
  if (!streamingBubble) return;
  const content = streamingBubble.querySelector('.markdown');
  if (content) content.innerHTML = renderMarkdown(text);
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (nearBottom) scrollToBottom();
}

function finalizeStreamingBubble(finalText, rounds, msg) {
  if (!streamingBubble) return false;
  const content = streamingBubble.querySelector('.markdown');
  if (content) content.innerHTML = renderMarkdown(finalText);
  streamingBubble.classList.remove('streaming');
  if (rounds) streamingBubble.appendChild(buildRoundsDetails(rounds));
  if (msg) attachToolbar(streamingBubble, msg);
  streamingBubble = null;
  markRegenEligible();
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

  promptEl.value = '';

  // If a pipeline is already running, queue this message instead.
  // It'll be processed when the current run finishes.
  if (pipelineRunning) {
    enqueueMessage(text);
    return;
  }

  await processMessage(text);
  await drainQueue();
}

function enqueueMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg user queued';
  el.textContent = text;
  messagesEl.appendChild(el);
  emptyHint.style.display = 'none';
  scrollToBottom();
  messageQueue.push({ text, bubbleEl: el });
}

async function drainQueue() {
  while (messageQueue.length > 0) {
    const next = messageQueue.shift();
    await processMessage(next.text, next.bubbleEl);
  }
}

async function processMessage(text, existingBubble, skipPushUser) {
  pipelineRunning = true;
  setRunning(true);

  if (!skipPushUser) {
    const userMsg = { role: 'user', content: text, ts: Date.now() };
    conversation.messages.push(userMsg);
    if (existingBubble && existingBubble.isConnected) {
      existingBubble.classList.remove('queued');
      currentUserBubble = existingBubble;
    } else {
      currentUserBubble = appendMessageElement(userMsg);
    }
    await persist();
  } else {
    // regenerate path: user msg already in conversation, no DOM change needed
    currentUserBubble = null;
  }

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
      removeStreamingBubble();
      if (!skipPushUser) {
        // Normal turn: roll back the user message we optimistically added
        if (currentUserBubble) {
          currentUserBubble.remove();
          currentUserBubble = null;
        }
        conversation.messages.pop();
        await persist();
        promptEl.value = text;
      }
      // For regenerate cancel: leave the existing user msg in place,
      // user can hit regenerate again or edit.
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
    const finalized = finalizeStreamingBubble(finalText, assistantMsg.rounds, assistantMsg);
    if (!finalized) {
      appendMessageElement(assistantMsg);
    }

    await persist();
    scrollToBottom();
  } catch (err) {
    clearThinking();
    showError(err.message ?? String(err));
  } finally {
    currentUserBubble = null;
    pipelineRunning = false;
    setRunning(false);
  }
}

function removeLastMessageElement() {
  const all = messagesEl.querySelectorAll('.msg');
  if (all.length > 0) all[all.length - 1].remove();
  if (conversation.messages.length === 0) emptyHint.style.display = '';
}

function setRunning(running) {
  promptEl.disabled = false;
  sendBtn.disabled = false;
  sendBtn.hidden = false;
  stopBtn.hidden = !running;
  document.body.classList.toggle('pipeline-running', running);
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
  if (conversation.messages.length === 0 && messageQueue.length === 0) return;
  if (!confirm('清空当前对话？这会删除所有消息和排队中的消息。')) return;
  conversation = { messages: [] };
  // also flush any queued messages and their visual bubbles
  for (const q of messageQueue) {
    if (q.bubbleEl) q.bubbleEl.remove();
  }
  messageQueue.length = 0;
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
