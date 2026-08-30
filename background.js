import { TelegramRelay } from './telegram_relay.js';

// Action icon click → open chat.html in its own dedicated browser window.
// Why a separate window: when chat.html shares a window with other tabs,
// switching to another tab in that window puts chat.html (and its 4
// embedded iframes) into visibilityState='hidden'. Chrome then queues SSE
// callbacks until the tab becomes visible again — which manifests as
// ChatGPT/DeepSeek "freezing" until the user looks at chat. With chat in
// its own window, chat.html is always the active tab in that window
// regardless of which other Chrome window the user is using.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(console.error);

async function openOrFocusChatWindow() {
  const chatUrl = chrome.runtime.getURL('chat.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === chatUrl || t.url?.startsWith(chatUrl + '#'));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    try {
      // Re-maximize in case it was minimized/restored
      await chrome.windows.update(existing.windowId, { focused: true, state: 'maximized' });
    } catch (_) {}
    return existing.id;
  }
  // Two-step: chrome.windows.create rejects `state` together with bounds,
  // so create with bounds first, then update to maximized.
  const win = await chrome.windows.create({
    url: chatUrl,
    type: 'normal',
    focused: true,
    width: 1200,
    height: 900
  });
  try {
    await chrome.windows.update(win.id, { state: 'maximized' });
  } catch (_) {}
  return win.tabs?.[0]?.id ?? null;
}

chrome.action.onClicked.addListener(async () => {
  try { await openOrFocusChatWindow(); } catch (_) {}
});

// Bulk-delete Gemini conversation history. Opens gemini.google.com in a
// top-frame tab (so the chat list UI loads with all controls — temp chat
// gating doesn't apply to deletion), then walks the side panel clicking
// each conversation's "更多选项" → "删除" → confirm dialog.
async function cleanGeminiHistory() {
  const tab = await chrome.tabs.create({
    url: 'https://gemini.google.com/app',
    active: true
  });
  // Wait for Gemini to fully render the chat list
  await new Promise(r => setTimeout(r, 5000));

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const stats = { total: 0, deleted: 0, skipped: 0, error: null };

      // Helper: find visible button matching predicate
      const findVisible = (selectors, predicate) => {
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.offsetParent === null) continue; // not visible
            if (!predicate || predicate(el)) return el;
          }
        }
        return null;
      };

      // Each saved chat has a button with aria-label ending in "的更多选项"
      const moreSelector = 'button[aria-label$="的更多选项"], button[aria-label$="More options"]';

      stats.total = document.querySelectorAll(moreSelector).length;
      if (stats.total === 0) {
        stats.error = '没找到对话列表 — Gemini 页面可能没加载完，或没有历史可删';
        return stats;
      }

      let consecutiveStuck = 0;
      let prevCount = stats.total;

      while (consecutiveStuck < 3) {
        const btns = document.querySelectorAll(moreSelector);
        if (btns.length === 0) break;

        // Detect stuck (delete didn't reduce count)
        if (btns.length >= prevCount) {
          consecutiveStuck++;
        } else {
          consecutiveStuck = 0;
        }
        prevCount = btns.length;

        // Open ⋮ menu for first chat
        const firstMore = btns[0];
        firstMore.click();
        await sleep(450);

        // Find "删除" / "Delete" menu item
        let deleteItem = null;
        const candidates = document.querySelectorAll('[role="menuitem"], button, [role="option"]');
        for (const c of candidates) {
          if (c.offsetParent === null) continue;
          const txt = (c.textContent || '').trim();
          const lbl = c.getAttribute('aria-label') || '';
          if (/^删除$|^删除聊天/.test(txt) || /^Delete( chat)?$/i.test(txt) ||
              /删除/.test(lbl) || /Delete/i.test(lbl)) {
            // Skip if it's a "delete account" or unrelated. Heuristic: must be in popped menu near our click.
            deleteItem = c;
            break;
          }
        }

        if (!deleteItem) {
          // Close the menu via Escape and skip
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
          }));
          await sleep(200);
          stats.skipped++;
          continue;
        }

        deleteItem.click();
        await sleep(500);

        // Confirmation dialog: find a visible 删除/Delete button (different from menu's)
        let confirmBtn = null;
        const dialogBtns = document.querySelectorAll('div[role="dialog"] button, mat-dialog-container button');
        for (const b of dialogBtns) {
          if (b.offsetParent === null) continue;
          const txt = (b.textContent || '').trim();
          if (/^删除$/.test(txt) || /^Delete$/i.test(txt)) {
            confirmBtn = b;
            break;
          }
        }
        // Fallback: any visible button with text "删除" / "Delete" (no other text)
        if (!confirmBtn) {
          const allBtns = document.querySelectorAll('button');
          for (const b of allBtns) {
            if (b.offsetParent === null) continue;
            const txt = (b.textContent || '').trim();
            if (txt === '删除' || /^Delete$/i.test(txt)) {
              confirmBtn = b;
              break;
            }
          }
        }

        if (confirmBtn) {
          confirmBtn.click();
          await sleep(900); // wait for chat to be removed from list
          stats.deleted++;
        } else {
          // No confirm button found — close any open dialog
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
          }));
          await sleep(200);
          stats.skipped++;
        }
      }

      if (consecutiveStuck >= 3) {
        stats.error = '连续 3 次没能删除（选择器可能变了，或剩下的是 pinned 不可删）';
      }
      return stats;
    }
  });
  return res?.result ?? { error: 'no result from script' };
}

const PROVIDERS = {
  chatgpt: {
    startUrl: 'https://chatgpt.com/?temporary-chat=true',
    matchUrls: ['https://chatgpt.com/', 'https://chat.openai.com/']
  },
  gemini: {
    startUrl: 'https://gemini.google.com/app',
    matchUrls: ['https://gemini.google.com/']
  },
  deepseek: {
    startUrl: 'https://chat.deepseek.com/',
    matchUrls: ['https://chat.deepseek.com/']
  },
  kimi: {
    startUrl: 'https://www.kimi.com/',
    matchUrls: ['https://www.kimi.com/', 'https://kimi.com/']
  }
};

const ALL_PROVIDERS = ['chatgpt', 'gemini', 'deepseek', 'kimi'];
const PREFERRED_FINAL_EDITOR = 'gemini';

function pickFinalEditor(enabled) {
  if (enabled.includes(PREFERRED_FINAL_EDITOR)) return PREFERRED_FINAL_EDITOR;
  return enabled[0];
}

// =================== Grid (iframe) mode registry ===================
//
// In the new iframe-based architecture, all 4 AI sites run as iframes inside
// a single grid.html tab. Each iframe's content script registers itself on
// load via CONTENT_SCRIPT_REGISTER, so SW can map provider → frameId for
// targeted message dispatch.

// gridTabId is the tab containing the embedded AI iframes. As of v0.46
// this is the chat.html workspace tab — chat UI + 4 hidden iframes all
// in one tab. No separate window. For backward compat, falls back to
// grid.html if a chat.html tab isn't present (e.g., user manually opens
// grid.html for debugging).
let gridTabId = null;
// providerFrames: tabId → { provider → frameId }
const providerFrames = new Map();

async function getOrCreateGridTab() {
  if (gridTabId) {
    try {
      const tab = await chrome.tabs.get(gridTabId);
      if (tab) return gridTabId;
    } catch (_) {
      gridTabId = null;
      providerFrames.delete(gridTabId);
    }
  }
  // Look for an already-open chat.html or grid.html tab anywhere
  const chatUrl = chrome.runtime.getURL('chat.html');
  const gridUrl = chrome.runtime.getURL('grid.html');
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url === chatUrl || t.url?.startsWith(chatUrl + '#') ||
          t.url === gridUrl || t.url?.startsWith(gridUrl + '#')) {
        gridTabId = t.id;
        schedulePersistDebug();
        return gridTabId;
      }
    }
  } catch (_) {}
  // None open — create chat.html in its own dedicated browser window so
  // the user can browse other tabs without throttling chat's iframes.
  // Two-step (bounds, then maximize) — Chrome rejects state+bounds combo.
  const win = await chrome.windows.create({
    url: chatUrl,
    type: 'normal',
    focused: true,
    width: 1200,
    height: 900
  });
  try {
    await chrome.windows.update(win.id, { state: 'maximized' });
  } catch (_) {}
  gridTabId = win.tabs?.[0]?.id ?? null;
  schedulePersistDebug();
  return gridTabId;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === gridTabId) {
    gridTabId = null;
  }
  providerFrames.delete(tabId);
});

function swSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function swWaitUntil(predicate, { timeoutMs, intervalMs }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await swSleep(intervalMs);
  }
  throw new Error('swWaitUntil timeout');
}

function getFrameId(tabId, provider) {
  return providerFrames.get(tabId)?.[provider];
}

async function ensureGridReady(expectedProviders) {
  const tabId = await getOrCreateGridTab();
  await swWaitUntil(() => {
    const map = providerFrames.get(tabId) ?? {};
    return expectedProviders.every(p => map[p] != null);
  }, { timeoutMs: 30000, intervalMs: 500 });
  return tabId;
}

// Reset an iframe to its provider's start URL for a fresh chat.
// We can't executeScript on the chrome-extension:// top frame, and runtime
// broadcasts are flaky from SW. So we tell the iframe's own content script
// to navigate itself — chrome.tabs.sendMessage(tabId, msg, { frameId })
// reaches content scripts directly regardless of origin.
async function reloadProviderFrame(gridTabId, provider) {
  const map = providerFrames.get(gridTabId);
  const oldFrameId = map?.[provider];

  if (oldFrameId == null) {
    // No prior frame — wait for initial registration only
    await swWaitUntil(
      () => providerFrames.get(gridTabId)?.[provider] != null,
      { timeoutMs: 30000, intervalMs: 500 }
    );
    await swSleep(1500);
    return;
  }

  if (map) delete map[provider];

  const startUrl = PROVIDERS[provider]?.startUrl;
  if (!startUrl) throw new Error(`Unknown provider ${provider}`);

  try {
    await chrome.tabs.sendMessage(
      gridTabId,
      { type: 'RESET_TO_START', url: startUrl },
      { frameId: oldFrameId }
    );
  } catch (err) {
    // Navigation kills the message channel — expected, ignore that specific case
    const msg = String(err?.message ?? '');
    if (!msg.includes('message channel closed') &&
        !msg.includes('Receiving end does not exist')) {
      throw new Error(`reset iframe failed: ${msg}`);
    }
  }

  await swWaitUntil(
    () => providerFrames.get(gridTabId)?.[provider] != null,
    { timeoutMs: 30000, intervalMs: 500 }
  );

  // Wait until the iframe's input is actually present + autoInit has settled.
  // Probe at 200ms intervals (was 500ms) for faster detection — input usually
  // appears in 1-2 ticks. Total budget 8s. Failure fallback shortened from
  // 1.5s → 800ms; if probing fully failed the input probably won't appear
  // soon anyway.
  const newFrameId = providerFrames.get(gridTabId)?.[provider];
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { // up to 8s at 200ms
    try {
      const r = await chrome.tabs.sendMessage(
        gridTabId,
        { type: 'PROBE_STATE' },
        { frameId: newFrameId }
      );
      if (r?.ok && r.state?.input) {
        ready = true;
        break;
      }
    } catch (_) {}
    await swSleep(200);
  }
  if (!ready) await swSleep(800);
}

// Kimi-specific: direct Lexical injection. Kimi's input is a Lexical
// editor (Meta's framework) wrapped in Vue. The Lexical editor instance
// is attached directly to the contenteditable element as
// `__lexicalEditor` — no fiber walk needed (Vue ≠ React).
async function injectKimiPromptViaLexical(gridTabId, frameId, text) {
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 500;
  let lastErr = 'unknown';
  let lastDiag = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await tryInjectKimiOnce(gridTabId, frameId, text);
    if (r?.ok) return r;
    lastErr = r?.error ?? 'no result';
    if (r?.diag) lastDiag = r.diag;
    await swSleep(RETRY_DELAY_MS);
  }
  return {
    ok: false,
    error: `Kimi Lexical not ready after ${MAX_ATTEMPTS} attempts: ${lastErr}`,
    diag: lastDiag
  };
}

async function tryInjectKimiOnce(gridTabId, frameId, text) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: gridTabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (txt) => {
        const diag = {};
        const editorEl = document.querySelector(
          'div[contenteditable="true"][data-lexical-editor="true"], ' +
          'div[contenteditable="true"][role="textbox"], ' +
          'div[contenteditable="true"]'
        );
        if (!editorEl) return { ok: false, error: 'no editor element', diag };
        diag.editorClass = editorEl.className?.slice(0, 60) ?? null;
        diag.dataLexical = editorEl.getAttribute('data-lexical-editor');

        // Strategy 1: __lexicalEditor.setEditorState
        const lex = editorEl.__lexicalEditor;
        diag.hasLexEditor = !!lex;
        if (lex) {
          diag.lexMethods = ['parseEditorState', 'setEditorState', 'update', 'dispatchCommand', 'focus']
            .filter(m => typeof lex[m] === 'function')
            .join(',');
          if (typeof lex.parseEditorState === 'function' &&
              typeof lex.setEditorState === 'function') {
            try {
              const lines = txt.split('\n');
              const stateJson = {
                root: {
                  children: lines.map(line => ({
                    type: 'paragraph',
                    format: '',
                    indent: 0,
                    version: 1,
                    direction: null,
                    textFormat: 0,
                    children: line.length === 0 ? [] : [{
                      type: 'text',
                      text: line,
                      format: 0,
                      style: '',
                      mode: 'normal',
                      detail: 0,
                      version: 1
                    }]
                  })),
                  direction: null, format: '', indent: 0, type: 'root', version: 1
                }
              };
              const newState = lex.parseEditorState(stateJson);
              lex.setEditorState(newState);
              await new Promise(r => setTimeout(r, 80));
              const got = editorEl.innerText ?? editorEl.textContent ?? '';
              const wantedKey = txt.replace(/\s+/g, '').slice(0, 20);
              if (got.replace(/\s+/g, '').includes(wantedKey)) {
                return { ok: true, method: 'lexical/setEditorState', diag };
              }
              diag.lexRead = got.slice(0, 30);
            } catch (err) {
              diag.lexErr = err.message ?? String(err);
            }
          }
        }

        // Strategy 2: DOM mutation fallback (same trick that works for PM)
        try {
          const oldHTML = editorEl.innerHTML;
          const lines = txt.split('\n');
          editorEl.innerHTML = '';
          for (const line of lines) {
            const p = document.createElement('p');
            if (line.length === 0) p.appendChild(document.createElement('br'));
            else p.appendChild(document.createTextNode(line));
            editorEl.appendChild(p);
          }
          await new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            requestAnimationFrame(() => requestAnimationFrame(finish));
            setTimeout(finish, 200);
          });
          const got = editorEl.innerText ?? editorEl.textContent ?? '';
          const wantedKey = txt.replace(/\s+/g, '').slice(0, 20);
          if (got.replace(/\s+/g, '').includes(wantedKey)) {
            return { ok: true, method: 'dom-mutation', diag };
          }
          editorEl.innerHTML = oldHTML;
          diag.domRead = got.slice(0, 30);
        } catch (err) {
          diag.domErr = err.message ?? String(err);
        }

        return { ok: false, error: 'all Kimi strategies failed', diag };
      },
      args: [text]
    });
    return res?.result ?? { ok: false, error: 'no result from executeScript' };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// Kimi reconnaissance probe — dumps editor DOM + framework hints + React
// fiber chain + window globals to diag. Doesn't modify anything. Lets us
// see what framework Kimi uses so we can write a hijack for it.
async function probeKimiEditor(gridTabId, frameId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: gridTabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        const out = { ts: Date.now() };
        // Find the input element — Kimi uses contenteditable or textbox role
        const inputEl = document.querySelector(
          'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea, [role="textbox"]'
        );
        if (!inputEl) return { error: 'no input element found' };

        out.tag = inputEl.tagName;
        out.id = inputEl.id || null;
        out.className = (inputEl.className?.slice?.(0, 200)) ?? null;
        out.contentEditable = inputEl.getAttribute('contenteditable');
        out.role = inputEl.getAttribute('role');
        out.dataAttrs = {};
        for (const a of inputEl.attributes) {
          if (a.name.startsWith('data-')) out.dataAttrs[a.name] = a.value.slice(0, 50);
        }

        // Own props (filter out React fiber/props keys for readability)
        out.ownKeys = Object.keys(inputEl)
          .filter(k => !k.startsWith('__react'))
          .slice(0, 30);

        // Check for known editor framework hints on element + ancestors
        const frameworks = [];
        let node = inputEl;
        for (let i = 0; i < 8 && node; i++) {
          const cls = node.className?.toString?.() ?? '';
          if (cls.includes('ql-')) frameworks.push(`quill@${i}:${cls.slice(0, 60)}`);
          if (cls.includes('ProseMirror')) frameworks.push(`pm@${i}`);
          if (cls.includes('lexical') || node.getAttribute?.('data-lexical-editor')) frameworks.push(`lexical@${i}`);
          if (cls.includes('tiptap') || cls.includes('prosemirror')) frameworks.push(`tiptap@${i}`);
          if (cls.includes('milkdown')) frameworks.push(`milkdown@${i}`);
          if (cls.includes('cm-') || cls.includes('CodeMirror')) frameworks.push(`codemirror@${i}`);
          if (cls.includes('monaco')) frameworks.push(`monaco@${i}`);
          if (cls.includes('slate')) frameworks.push(`slate@${i}`);
          // Editor-instance properties
          for (const k of ['__quill', '__lexicalEditor', '__pmView', '__editor', '_editor']) {
            if (node[k]) frameworks.push(`prop@${i}:${k}`);
          }
          node = node.parentElement;
        }
        out.frameworkHints = frameworks;

        // Window globals
        const globals = [];
        for (const g of ['Quill', 'EditorView', 'EditorState', 'Lexical', 'createEditor', 'Tiptap', 'Slate', 'monaco', 'CodeMirror']) {
          if (typeof window[g] !== 'undefined') globals.push(g);
        }
        out.windowGlobals = globals;

        // React fiber walk (just record component types up to depth 20)
        let fiberHost = inputEl;
        let fiberKey = null;
        for (let i = 0; i < 25 && fiberHost && !fiberKey; i++) {
          const k = Object.keys(fiberHost).find(k => k.startsWith('__reactFiber'));
          if (k) fiberKey = k;
          else fiberHost = fiberHost.parentElement;
        }
        if (fiberKey) {
          out.fiberKey = fiberKey.slice(0, 30);
          let f = fiberHost[fiberKey];
          const types = [];
          // Also collect any props that look editor-shaped
          const editorPropPaths = [];
          for (let d = 0; f && d < 30; d++, f = f.return) {
            const t = f.type;
            const tn = typeof t === 'string'
              ? t
              : (t?.displayName ?? t?.name ?? (typeof t === 'function' ? 'fn' : 'obj'));
            types.push(tn);
            // Look for props/state with editor-suggestive shapes
            const props = f.memoizedProps;
            if (props && typeof props === 'object') {
              for (const pk of Object.keys(props)) {
                const v = props[pk];
                if (!v || typeof v !== 'object') continue;
                if (typeof v.dispatch === 'function' || typeof v.insertText === 'function' ||
                    typeof v.setText === 'function' || typeof v.setEditorState === 'function') {
                  editorPropPaths.push(`fiber@${d}/props.${pk}`);
                }
                if (v.current && typeof v.current === 'object' &&
                    (typeof v.current.dispatch === 'function' || typeof v.current.insertText === 'function')) {
                  editorPropPaths.push(`fiber@${d}/props.${pk}.current`);
                }
              }
            }
          }
          out.fiberTypes = types.slice(0, 16).join(',');
          out.editorPropPaths = editorPropPaths;
        } else {
          out.fiberKey = null;
        }

        // Sample the input's textContent / innerHTML structure
        out.textContent = (inputEl.textContent ?? '').slice(0, 60);
        out.innerHTMLPrefix = (inputEl.innerHTML ?? '').slice(0, 200);

        return out;
      }
    });
    return res?.result ?? { error: 'no result from executeScript' };
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
}

// Gemini-specific: inject prompt by directly calling Quill's API in the
// iframe's main world. This bypasses the focus / execCommand requirement
// that fails for Quill in iframes. Retries because Quill may not be
// attached yet right after iframe reload + autoInit clicks.
async function injectGeminiPromptViaQuill(gridTabId, frameId, text) {
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 500;
  let lastErr = 'unknown';
  let lastDiag = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await tryInjectQuillOnce(gridTabId, frameId, text);
    if (r?.ok) return r;
    lastErr = r?.error ?? 'no result';
    if (r?.diag) lastDiag = r.diag;
    await swSleep(RETRY_DELAY_MS);
  }
  return {
    ok: false,
    error: `Quill not ready after ${MAX_ATTEMPTS} attempts: ${lastErr}`,
    diag: lastDiag
  };
}

async function tryInjectQuillOnce(gridTabId, frameId, text) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: gridTabId, frameIds: [frameId] },
      world: 'MAIN',
      func: (txt) => {
        const diag = {
          hasQuillGlobal: !!window.Quill,
          qlEditorFound: !!document.querySelector('.ql-editor'),
          richTextareaFound: !!document.querySelector('rich-textarea'),
          contentEditableCount: document.querySelectorAll('[contenteditable="true"]').length,
          editorInputClass: null,
          foundVia: null,
          quillKeys: null
        };

        // The .ql-editor element is the Scroll *blot*. The Quill *instance* is
        // attached to the .ql-container parent. Quill.find(scrollEl) returns
        // the blot, not the instance — so we have to find the container.
        const isQuillInstance = (obj) =>
          obj && (
            typeof obj.setText === 'function' ||
            typeof obj.insertText === 'function' ||
            typeof obj.setContents === 'function' ||
            (obj.clipboard && typeof obj.clipboard.dangerouslyPasteHTML === 'function')
          );

        // Find Quill instance — try multiple known patterns
        const findQuill = () => {
          // 0. Quill.find() on the .ql-container (correct way to get instance)
          if (window.Quill && window.Quill.find) {
            const container = document.querySelector('.ql-container');
            if (container) {
              const q = window.Quill.find(container);
              if (isQuillInstance(q)) { diag.foundVia = 'Quill.find(container)'; return q; }
              if (q && !diag.containerFindResult) {
                diag.containerFindResult = q.constructor?.name + ':' + Object.keys(q).slice(0, 8).join(',');
              }
            }
          }
          // 1. Quill.find() on .ql-editor (likely returns Scroll blot, but try)
          if (window.Quill && window.Quill.find) {
            const ed = document.querySelector('.ql-editor');
            if (ed) {
              const q = window.Quill.find(ed);
              if (isQuillInstance(q)) { diag.foundVia = 'Quill.find(editor)'; return q; }
            }
          }
          // 1b. Walk up from .ql-editor calling Quill.find at each ancestor
          if (window.Quill && window.Quill.find) {
            let node = document.querySelector('.ql-editor');
            for (let i = 0; i < 6 && node; i++) {
              const q = window.Quill.find(node);
              if (isQuillInstance(q)) { diag.foundVia = `Quill.find(ancestor@${i})`; return q; }
              node = node.parentElement;
            }
          }
          // 2. Walk up from .ql-editor checking for instance properties
          const editor = document.querySelector('.ql-editor');
          if (editor) {
            diag.editorInputClass = editor.className?.slice(0, 100) ?? null;
            let node = editor;
            for (let i = 0; i < 6 && node; i++) {
              for (const key of ['__quill', '_quill', 'quill']) {
                if (isQuillInstance(node[key])) {
                  diag.foundVia = `walk@${i}/${key}`;
                  return node[key];
                }
              }
              node = node.parentElement;
            }
          }
          // 3. Check rich-textarea web component
          const rt = document.querySelector('rich-textarea');
          if (rt) {
            diag.rtKeys = Object.keys(rt).filter(k => !k.startsWith('__react')).slice(0, 20).join(',');
            for (const key of ['__quill', '_quill', 'quill', '_editor', 'editor']) {
              const obj = rt[key];
              if (isQuillInstance(obj)) { diag.foundVia = `rt/${key}`; return obj; }
              if (isQuillInstance(obj?._quill)) { diag.foundVia = `rt/${key}._quill`; return obj._quill; }
              if (isQuillInstance(obj?.__quill)) { diag.foundVia = `rt/${key}.__quill`; return obj.__quill; }
            }
          }
          return null;
        };

        const quill = findQuill();
        if (!quill) return { ok: false, error: 'no Quill instance found', diag };
        diag.quillKeys = Object.keys(quill).slice(0, 20).join(',');

        // Dump all callable methods up the prototype chain so we can see what
        // API is actually exposed (Gemini may have stripped/renamed methods).
        const allMethods = new Set();
        let proto = quill;
        for (let i = 0; i < 6 && proto && proto !== Object.prototype; i++) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            try { if (typeof quill[k] === 'function') allMethods.add(k); }
            catch (_) {}
          }
          proto = Object.getPrototypeOf(proto);
        }
        diag.quillMethods = [...allMethods].slice(0, 60).join(',');
        diag.quillCtor = quill.constructor?.name ?? null;
        diag.hasSetText = typeof quill.setText === 'function';
        diag.hasInsertText = typeof quill.insertText === 'function';
        diag.hasSetContents = typeof quill.setContents === 'function';
        diag.hasUpdateContents = typeof quill.updateContents === 'function';
        diag.hasClipboard = !!quill.clipboard;
        diag.hasScroll = !!quill.scroll && typeof quill.scroll.insertAt === 'function';

        // We only accept methods that go through Quill's normal event pipeline
        // (so framework subscribers see the change and the send button enables).
        // scroll.insertAt was tried but bypasses events → host React doesn't
        // see the text → send button stays disabled → click does nothing.
        // CRITICAL: pass source='user' on every API call. Default 'api' source
        // is filtered by many React integrations (including Gemini's) to avoid
        // feedback loops — they only update state on 'user' source. Without
        // this, setText fires text-change with source='api', Gemini ignores it,
        // send button stays disabled, click does nothing.
        const SOURCE = 'user';
        const setSelectionEnd = () => {
          try {
            const len = typeof quill.getLength === 'function' ? quill.getLength() : (txt.length + 1);
            if (typeof quill.setSelection === 'function') {
              quill.setSelection(len - 1, 0, SOURCE);
            }
          } catch (_) {}
        };

        // Mark Quill as focused — Gemini's submit handler appears to check
        // editor focus state before processing send-button clicks. Without
        // this, setText succeeds but the send click is silently rejected.
        const finalize = () => {
          setSelectionEnd();
          try { if (typeof quill.focus === 'function') quill.focus(); } catch (_) {}
        };

        try {
          if (typeof quill.setText === 'function') {
            quill.setText(txt + '\n', SOURCE);
            finalize();
            return { ok: true, method: 'setText/user', diag };
          }
          if (typeof quill.insertText === 'function') {
            if (typeof quill.deleteText === 'function' && typeof quill.getLength === 'function') {
              try { quill.deleteText(0, quill.getLength(), SOURCE); } catch (_) {}
            }
            quill.insertText(0, txt, SOURCE);
            finalize();
            return { ok: true, method: 'insertText/user', diag };
          }
          if (typeof quill.setContents === 'function') {
            quill.setContents([{ insert: txt + '\n' }], SOURCE);
            finalize();
            return { ok: true, method: 'setContents/user', diag };
          }
          if (quill.clipboard && typeof quill.clipboard.dangerouslyPasteHTML === 'function') {
            const escaped = txt
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
            quill.clipboard.dangerouslyPasteHTML(0, '<p>' + escaped + '</p>', SOURCE);
            finalize();
            return { ok: true, method: 'clipboard.dangerouslyPasteHTML', diag };
          }
        } catch (err) {
          return { ok: false, error: err.message ?? String(err), diag };
        }
        return { ok: false, error: 'no event-firing injection method on Quill', diag };
      },
      args: [text]
    });
    return res?.result ?? { ok: false, error: 'no result from executeScript' };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// ChatGPT-specific: inject prompt via the rich-text editor's internal API
// (ProseMirror EditorView, or Lexical setEditorState). This bypasses the
// focus + execCommand requirement that fails when the iframe doesn't have
// real document focus, which is the blocker for moving grid into a
// background/minimized window.
async function injectChatGPTPromptViaEditor(gridTabId, frameId, text) {
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 500;
  let lastErr = 'unknown';
  let lastDiag = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await tryInjectChatGPTOnce(gridTabId, frameId, text);
    if (r?.ok) return r;
    lastErr = r?.error ?? 'no result';
    if (r?.diag) lastDiag = r.diag;
    await swSleep(RETRY_DELAY_MS);
  }
  return {
    ok: false,
    error: `ChatGPT editor not ready after ${MAX_ATTEMPTS} attempts: ${lastErr}`,
    diag: lastDiag
  };
}

async function tryInjectChatGPTOnce(gridTabId, frameId, text) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: gridTabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (txt) => {
        // Diagnostic data attached to result so we can debug hijack failures
        // without needing extra probes.
        const diag = { tried: [], editorTag: null, editorClass: null, fiberKey: null };

        const editorEl = document.querySelector(
          '#prompt-textarea, .ProseMirror[contenteditable="true"], [data-lexical-editor="true"], div[contenteditable="true"]'
        );
        if (!editorEl) return { ok: false, error: 'editor element not found', diag };
        diag.editorTag = editorEl.tagName;
        diag.editorClass = editorEl.className?.slice(0, 100) ?? null;
        diag.editorId = editorEl.id || null;
        diag.editorContentEditable = editorEl.getAttribute('contenteditable');
        diag.editorDataLexical = editorEl.getAttribute('data-lexical-editor');

        // ----- Strategy 1: ProseMirror EditorView -----
        // ChatGPT historically uses ProseMirror. Walk React fibers to find
        // the EditorView instance — it has .dispatch and .state.tr.
        const findPMView = (rootEl) => {
          const isPMView = (obj) =>
            obj && typeof obj.dispatch === 'function' &&
            obj.state && typeof obj.state.doc === 'object' &&
            typeof obj.state.tr === 'object';

          // Direct instance properties on the editor element
          for (const key of ['pmViewDesc', '__view', '_view', 'view']) {
            if (isPMView(rootEl[key])) { diag.tried.push(`elProp/${key}`); return rootEl[key]; }
            if (isPMView(rootEl[key]?.view)) { diag.tried.push(`elProp/${key}.view`); return rootEl[key].view; }
          }

          // Find a fiber-bearing element by walking up. ChatGPT mounts React
          // on an ancestor, not on the contenteditable itself.
          let fiberKey = null;
          let fiberHost = rootEl;
          let ancestorDepth = 0;
          while (fiberHost && !fiberKey && ancestorDepth < 25) {
            const k = Object.keys(fiberHost).find(k =>
              k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            if (k) { fiberKey = k; break; }
            fiberHost = fiberHost.parentElement;
            ancestorDepth++;
          }
          diag.fiberKey = fiberKey ? fiberKey.slice(0, 30) : null;
          diag.fiberAncestorDepth = ancestorDepth;
          if (!fiberKey) return null;
          let fiber = fiberHost[fiberKey];

          // Helper: scan ANY object for PMView at common nested keys. Most
          // critically, useRef stores its value at `.current` — that's where
          // ProseMirror's EditorView typically lives in React apps.
          const scanForPMView = (obj, label) => {
            if (!obj) return null;
            if (isPMView(obj)) { diag.tried.push(`${label}/direct`); return obj; }
            for (const k of ['current', 'view', 'editorView', '_view', 'editor']) {
              const v = obj[k];
              if (isPMView(v)) { diag.tried.push(`${label}/${k}`); return v; }
              if (v && typeof v === 'object') {
                for (const k2 of ['view', 'current']) {
                  if (isPMView(v[k2])) { diag.tried.push(`${label}/${k}.${k2}`); return v[k2]; }
                }
              }
            }
            return null;
          };

          const fiberTypes = [];
          for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
            const t = fiber.type;
            const typeName = typeof t === 'string'
              ? t
              : (t?.displayName ?? t?.name ?? (typeof t === 'function' ? 'fn' : 'obj'));
            fiberTypes.push(typeName);

            // Props
            const props = fiber.memoizedProps;
            if (props && typeof props === 'object') {
              for (const k of Object.keys(props)) {
                const found = scanForPMView(props[k], `fiber@${depth}/props.${k}`);
                if (found) return found;
              }
            }

            // Hooks linked list — useRef stores at memoizedState.current
            let hook = fiber.memoizedState;
            for (let i = 0; hook && i < 40; i++, hook = hook.next) {
              const ms = hook.memoizedState;
              const found = scanForPMView(ms, `fiber@${depth}/hook${i}`);
              if (found) return found;
              if (Array.isArray(ms)) {
                for (let idx = 0; idx < ms.length && idx < 10; idx++) {
                  const f2 = scanForPMView(ms[idx], `fiber@${depth}/hook${i}[${idx}]`);
                  if (f2) return f2;
                }
              }
            }

            // stateNode for class components
            const sn = fiber.stateNode;
            if (sn && typeof sn === 'object') {
              const found = scanForPMView(sn, `fiber@${depth}/stateNode`);
              if (found) return found;
            }
          }
          diag.fiberTypes = fiberTypes.slice(0, 14).join(',');
          return null;
        };

        const pmView = findPMView(editorEl);
        if (pmView) {
          try {
            const { state } = pmView;
            const docSize = state.doc.content.size;
            const tr = state.tr.delete(0, docSize).insertText(txt);
            pmView.dispatch(tr);
            return { ok: true, method: 'prosemirror' };
          } catch (err) {
            return { ok: false, error: 'pm dispatch failed: ' + (err.message ?? String(err)) };
          }
        }

        // ----- Strategy 2: Lexical -----
        // If ChatGPT switched to Lexical, the editor element has
        // [data-lexical-editor="true"] and an editor instance reachable via
        // __lexicalEditor or React fiber.
        const findLexical = (rootEl) => {
          if (rootEl.__lexicalEditor) return rootEl.__lexicalEditor;
          const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber'));
          if (!fiberKey) return null;
          let fiber = rootEl[fiberKey];
          for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const cands = [
              fiber.memoizedProps?.editor,
              fiber.memoizedState?.editor,
              fiber.stateNode?.editor
            ];
            for (const c of cands) {
              if (c && typeof c.parseEditorState === 'function' && typeof c.setEditorState === 'function') {
                return c;
              }
            }
          }
          return null;
        };

        const lex = findLexical(editorEl);
        if (lex) {
          try {
            const stateJson = {
              root: {
                children: [{
                  type: 'paragraph',
                  format: '',
                  indent: 0,
                  version: 1,
                  direction: null,
                  children: [{
                    type: 'text',
                    text: txt,
                    format: 0,
                    style: '',
                    mode: 'normal',
                    detail: 0,
                    version: 1
                  }]
                }],
                direction: null,
                format: '',
                indent: 0,
                type: 'root',
                version: 1
              }
            };
            const newState = lex.parseEditorState(stateJson);
            lex.setEditorState(newState);
            return { ok: true, method: 'lexical' };
          } catch (err) {
            return { ok: false, error: 'lexical setEditorState failed: ' + (err.message ?? String(err)) };
          }
        }

        // ----- Strategy 3: editor.pmViewDesc reverse lookup -----
        // Some PM forks store the view on the doc-level NodeViewDesc.
        try {
          const desc = editorEl.pmViewDesc;
          if (desc) {
            for (const k of ['view', 'parent', 'editorView']) {
              const v = desc[k];
              if (v && typeof v.dispatch === 'function' && v.state?.doc) {
                const { state } = v;
                const tr = state.tr.delete(0, state.doc.content.size).insertText(txt);
                v.dispatch(tr);
                return { ok: true, method: 'pmViewDesc/' + k, diag };
              }
            }
            diag.descKeys = Object.keys(desc).slice(0, 10).join(',');
          } else {
            diag.descKeys = 'no pmViewDesc';
          }
        } catch (err) { diag.desc3Err = err.message ?? String(err); }

        // ----- Strategy 4: direct DOM mutation -----
        // PM's domObserver watches for DOM mutations and creates matching
        // transactions when possible. Synthetic beforeinput is filtered by
        // isTrusted, but raw DOM changes go through MutationObserver which
        // doesn't have that gate.
        try {
          const oldHTML = editorEl.innerHTML;
          // Build PM-friendly content: a single <p> with text node.
          // Newlines split into multiple <p> blocks.
          const lines = txt.split('\n');
          editorEl.innerHTML = '';
          for (const line of lines) {
            const p = document.createElement('p');
            if (line.length === 0) {
              p.appendChild(document.createElement('br'));
            } else {
              p.appendChild(document.createTextNode(line));
            }
            editorEl.appendChild(p);
          }

          // Wait up to 200ms for PM's MutationObserver to process. rAF can
          // be throttled in non-foreground iframes, so use a setTimeout race
          // as a safety net against hanging.
          await new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            requestAnimationFrame(() => requestAnimationFrame(finish));
            setTimeout(finish, 200);
          });

          const got = editorEl.innerText ?? editorEl.textContent ?? '';
          const wantedKey = txt.replace(/\s+/g, '').slice(0, 20);
          if (got.replace(/\s+/g, '').includes(wantedKey)) {
            return { ok: true, method: 'dom-mutation', diag };
          }

          // PM may have reverted. Restore old content so we don't leave the
          // editor in a weird state — let execCommand path try afterwards.
          editorEl.innerHTML = oldHTML;
          diag.domMutationRead = got.slice(0, 30);
        } catch (err) { diag.domMutationErr = err.message ?? String(err); }

        return { ok: false, error: 'no PM view, no Lexical, no pmViewDesc, DOM mutation reverted', diag };
      },
      args: [text]
    });
    return res?.result ?? { ok: false, error: 'no result from executeScript' };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// Poll a single iframe for stable text output.
async function pollFrameUntilStable(gridTabId, frameId, signal, onPartial) {
  // 5s instead of 3s. 3s gave false-positive "done" when a provider paused
  // mid-stream for tool-use, fetch, or just a slow chunk — we'd capture a
  // sentence-fragment as final R2 output and kick off Final on it.
  const STABLE_MS = 5000;
  const FALLBACK_STABLE_MS = 12000;
  const TIMEOUT_MS = 300000;
  const POLL_MS = 500;
  // 180s. Was 90 → 120 → 180. Some providers (ChatGPT, DeepSeek) hit
  // rate-limit-adjacent slowness when the same conversation keeps probing
  // similar prompts, and parallel Phase 2 means 4 simultaneous server
  // requests can saturate the per-IP queue.
  const FIRST_TEXT_TIMEOUT_MS = 180000;

  let lastText = '';
  let lastChangedAt = Date.now();
  const start = Date.now();
  let consecutiveFails = 0;

  while (Date.now() - start < TIMEOUT_MS) {
    if (signal?.aborted) throw new Error('Pipeline cancelled');

    let state = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: gridTabId, frameIds: [frameId] },
        func: () => (typeof window.__multiAIPollState === 'function')
          ? window.__multiAIPollState()
          : null
      });
      state = res?.result ?? null;
      consecutiveFails = 0;
    } catch (err) {
      consecutiveFails++;
      if (consecutiveFails >= 5) {
        throw new Error(`Probe failed: ${err.message ?? String(err)}`);
      }
    }

    if (state && typeof state.text === 'string') {
      if (state.text !== lastText) {
        lastText = state.text;
        lastChangedAt = Date.now();
        if (typeof onPartial === 'function' && state.text) {
          try { onPartial(state.text); } catch (_) {}
        }
      }
      const stableFor = Date.now() - lastChangedAt;
      const elapsed = Date.now() - start;

      if (state.text && !state.stopVisible && !state.streaming && stableFor >= STABLE_MS) {
        return state.text;
      }
      if (state.text && stableFor >= FALLBACK_STABLE_MS) {
        return state.text;
      }
      if (!state.text && elapsed > FIRST_TEXT_TIMEOUT_MS) {
        throw new Error(`No assistant text appeared within ${Math.round(FIRST_TEXT_TIMEOUT_MS/1000)}s`);
      }
    }

    await swSleep(POLL_MS);
  }
  throw new Error('Generation did not complete within 5 minutes');
}

const MAX_ERRORS = 50;
const debugState = {
  errors: [],
  // keyed by `${stage}:${provider}`
  lastStages: {},
  lastResults: {},
  // Records whether each provider's editor-API hijack succeeded (e.g.
  // ChatGPT ProseMirror, Gemini Quill). "ok/<method>" or "fail:<reason>".
  hijackOutcome: {}
};

// Persist debug state across SW restarts — chrome.storage.session survives
// SW idle termination but not browser restart. Without this, debug bundles
// captured after a long pipeline run come back empty.
const DEBUG_STORE_KEY = 'debugState';

(async () => {
  try {
    const { [DEBUG_STORE_KEY]: stored } = await chrome.storage.session.get(DEBUG_STORE_KEY);
    if (stored) {
      if (Array.isArray(stored.errors)) debugState.errors = stored.errors;
      if (stored.lastStages) debugState.lastStages = stored.lastStages;
      if (stored.lastResults) debugState.lastResults = stored.lastResults;
      if (stored.hijackOutcome) debugState.hijackOutcome = stored.hijackOutcome;
    }
  } catch (_) {}
  // Rehydrate gridTabId in case SW restarted but the grid tab is still open.
  await rehydrateGridState().catch(() => {});
})();

// SW idle-terminates and loses in-memory state; the grid tab and its iframes
// are still alive in the browser, but providerFrames is empty until iframes
// re-register. We restore gridTabId from storage and ask iframes to
// re-announce themselves.
async function rehydrateGridState() {
  if (gridTabId) return;
  let candId = null;
  try {
    const { [DEBUG_STORE_KEY]: stored } = await chrome.storage.session.get(DEBUG_STORE_KEY);
    candId = stored?.gridTabIdSnapshot ?? null;
  } catch (_) { return; }
  if (!candId) return;
  try {
    const tab = await chrome.tabs.get(candId);
    const chatUrl = chrome.runtime.getURL('chat.html');
    const gridUrl = chrome.runtime.getURL('grid.html');
    const ok = tab?.url && (
      tab.url === chatUrl || tab.url.startsWith(chatUrl + '#') ||
      tab.url === gridUrl || tab.url.startsWith(gridUrl + '#')
    );
    if (!ok) return;
    gridTabId = candId;
  } catch (_) { return; }
  // Ping all frames to re-register. Errors are expected for frames that
  // don't have the content script (e.g. nested provider sub-iframes).
  try {
    await chrome.tabs.sendMessage(candId, { type: 'REREGISTER' });
  } catch (_) {}
  // Give registrations a moment to land before any caller reads providerFrames.
  await swSleep(300);
}

function schedulePersistDebug() {
  // No debounce — write immediately. SW lifecycle respects pending storage
  // ops, so calling without await still completes before SW idle-terminates.
  try {
    chrome.storage.session.set({ [DEBUG_STORE_KEY]: {
      errors: debugState.errors,
      lastStages: debugState.lastStages,
      lastResults: debugState.lastResults,
      hijackOutcome: debugState.hijackOutcome,
      gridTabIdSnapshot: gridTabId
    }}).catch(() => {});
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pushError(provider, stage, message) {
  debugState.errors.push({
    ts: new Date().toISOString(),
    provider,
    stage,
    message: String(message ?? '')
  });
  if (debugState.errors.length > MAX_ERRORS) debugState.errors.shift();
  schedulePersistDebug();
}

self.addEventListener('error', (e) => {
  pushError('sw', 'global', e.message ?? e.error?.message ?? 'unknown');
});
self.addEventListener('unhandledrejection', (e) => {
  pushError('sw', 'unhandled', e.reason?.message ?? String(e.reason));
});

function postProvider(provider, stage, payload) {
  const key = `${stage}:${provider}`;
  if (payload.stage) debugState.lastStages[key] = payload.stage;
  if (payload.status === 'done' || payload.status === 'failed') {
    debugState.lastResults[key] = { ...payload };
    schedulePersistDebug();
  }
  if (payload.status === 'failed' && payload.error) {
    pushError(provider, `${stage}/${debugState.lastStages[key] ?? '?'}`, payload.error);
  }
  chrome.runtime
    .sendMessage({ type: 'PROVIDER_UPDATE', provider, round: stage, ...payload })
    .catch(() => {});
}

async function collectDebug() {
  // SW may have just woken up — rehydrate gridTabId + ping iframes to
  // re-register before reading state.
  await rehydrateGridState().catch(() => {});

  const out = {
    timestamp: new Date().toISOString(),
    extension: chrome.runtime.getManifest()?.version ?? '?',
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '?',
    errors: [...debugState.errors].reverse(),
    hijackOutcome: { ...(debugState.hijackOutcome ?? {}) },
    providerStates: {},
    grid: {
      gridTabId: gridTabId ?? null,
      providerFrames: gridTabId ? (providerFrames.get(gridTabId) ?? {}) : {},
      gridTabUrl: null,
      gridTabStatus: null
    }
  };

  if (gridTabId) {
    try {
      const tab = await chrome.tabs.get(gridTabId);
      out.grid.gridTabUrl = tab.url;
      out.grid.gridTabStatus = tab.status;
      out.grid.gridTabActive = tab.active;
    } catch (err) {
      out.grid.error = err.message;
    }

    // Probe each iframe via tabs.sendMessage to its content script
    // (content_adapter.js has a PROBE_STATE handler that returns rich state).
    const frames = providerFrames.get(gridTabId) ?? {};
    for (const [provider, frameId] of Object.entries(frames)) {
      try {
        const r = await chrome.tabs.sendMessage(
          gridTabId,
          { type: 'PROBE_STATE' },
          { frameId }
        );
        out.grid['probe_' + provider] = r?.state ?? { error: r?.error ?? 'no state' };
      } catch (err) {
        out.grid['probe_' + provider] = { error: err.message ?? String(err) };
      }
    }
  }

  const stages = ['r1', 'r2', 'final'];
  for (const provider of ALL_PROVIDERS) {
    const perStage = {};
    for (const s of stages) {
      const lr = debugState.lastResults[`${s}:${provider}`];
      const ls = debugState.lastStages[`${s}:${provider}`];
      if (lr || ls) {
        perStage[s] = {
          lastStage: ls ?? null,
          lastResult: lr ? {
            status: lr.status,
            elapsedMs: lr.elapsedMs ?? null,
            error: lr.error ?? null,
            outputPreview: lr.output ? lr.output.slice(0, 200) : null
          } : null
        };
      }
    }
    out.providerStates[provider] = { perStage };
  }

  return out;
}

// =================== Stage runner ===================

async function runStage({ providers, prompts, stage, signal }) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('No providers specified');
  }
  if (signal?.aborted) throw new Error('Pipeline cancelled');

  for (const p of providers) {
    postProvider(p, stage, { status: 'running', stage: 'queued' });
  }

  const onPartial = stage === 'final'
    ? (provider, partial) => postProvider(provider, stage, {
        status: 'running', stage: 'generating', partialOutput: partial
      })
    : null;

  // Iframe-based pipeline:
  //   Phase 1 (reload + autoInit ready): parallel — independent
  //   Phase 2 (focus + submit): SERIAL — only one iframe can have focus at
  //                             a time, so contenteditable providers must
  //                             take turns (otherwise click-send races
  //                             against the next provider's focus steal)
  //   Phase 3 (wait for stable text): parallel — no focus needed here
  const gridTabId = await ensureGridReady(providers);

  const startedAt = Date.now();
  const startTimes = {};
  const failed = new Set();

  // ----- Phase 1: parallel reload -----
  await Promise.all(providers.map(async (provider) => {
    startTimes[provider] = Date.now();
    try {
      postProvider(provider, stage, { status: 'running', stage: 'preparing' });
      await reloadProviderFrame(gridTabId, provider);
    } catch (err) {
      failed.add(provider);
      postProvider(provider, stage, { status: 'failed', error: err?.message ?? String(err) });
    }
  }));

  if (signal?.aborted) throw new Error('Pipeline cancelled');

  const recordHijack = (provider, r) => {
    debugState.hijackOutcome ??= {};
    const summary = r?.ok ? `ok/${r.method}` : `fail:${r?.error ?? 'unknown'}`;
    const diagStr = r?.diag ? ` | diag=${JSON.stringify(r.diag)}` : '';
    debugState.hijackOutcome[`${stage}:${provider}`] = summary + diagStr;
    schedulePersistDebug();
  };

  // Per-provider submit + poll. Hijack already happened in the parallel
  // pre-pass; we just need to fire SUBMIT_AND_WAIT_START (which clicks
  // the send button) and wait for output. skipInput tells content_adapter
  // to verify the prompt is in the editor and click send (no setInputValue).
  async function submitAndPollOnce(provider, prompt, skipInput) {
    const frameId = getFrameId(gridTabId, provider);
    if (frameId == null) throw new Error(`No frameId for ${provider}`);

    postProvider(provider, stage, { status: 'running', stage: 'submitting' });

    // Gemini-specific: wait ~1s between Quill setText and clicking send.
    // Without this, Gemini's React onClick handler runs before its state
    // machine has fully consumed the source='user' text-change event, and
    // the click is silently rejected. R1/R2 worked because the serial
    // stagger naturally gave Gemini ~1.2s of wait (Gemini sorted last);
    // Final has only Gemini so no stagger, hence the explicit delay here.
    if (provider === 'gemini' && skipInput) {
      await swSleep(1000);
    }

    if (!skipInput && provider !== 'deepseek') {
      try {
        await chrome.runtime.sendMessage({ type: 'FOCUS_IFRAME', provider });
      } catch (_) {}
      await swSleep(600);
      try {
        const [check] = await chrome.scripting.executeScript({
          target: { tabId: gridTabId, frameIds: [frameId] },
          func: () => ({ hasFocus: document.hasFocus(), vis: document.visibilityState })
        });
        if (!check?.result?.hasFocus) {
          try {
            await chrome.runtime.sendMessage({ type: 'FOCUS_IFRAME_AGGRESSIVE', provider });
          } catch (_) {}
          await swSleep(400);
        }
      } catch (_) {}
    }

    const submitResp = await chrome.tabs.sendMessage(
      gridTabId,
      { type: 'SUBMIT_AND_WAIT_START', prompt, skipInput },
      { frameId }
    );
    if (!submitResp?.ok) throw new Error(submitResp?.error ?? 'submit failed');

    postProvider(provider, stage, { status: 'running', stage: 'generating' });

    const onPartialThis = onPartial ? (p) => onPartial(provider, p) : null;
    const text = await pollFrameUntilStable(gridTabId, frameId, signal, onPartialThis);
    if (!text) throw new Error('Empty output');
    return text;
  }

  // ----- Phase 2: SERIAL submit, then Phase 3: parallel poll -----
  // We tried parallel Phase 2 earlier — it broke Gemini's R1/R2 send-button
  // click. Final never had this issue because Final has only 1 provider.
  // The 4-way parallel submit must trigger some event-queue contention in
  // Gemini's React onClick handler (isTrusted=false detection that's only
  // strict under concurrent activity). Going serial costs ~2-3s on Phase 2
  // but makes Gemini submit auto-fire reliably.
  const submitOrder = [...providers];
  // Submit Gemini LAST so any contention from other providers is settled
  // before its click. Empirically Gemini is the most fragile.
  submitOrder.sort((a, b) => (a === 'gemini' ? 1 : 0) - (b === 'gemini' ? 1 : 0));

  // Run hijacks (no UI interaction) in parallel — fast and safe. Records
  // skipInput per provider so Phase 2's submit-click can run in serial.
  const skipInputMap = {};
  await Promise.all(providers.map(async (provider) => {
    if (failed.has(provider) || signal?.aborted) return;
    try {
      const frameId = getFrameId(gridTabId, provider);
      if (frameId == null) return;
      let r = null;
      if (provider === 'gemini') r = await injectGeminiPromptViaQuill(gridTabId, frameId, prompts[provider]);
      else if (provider === 'chatgpt') r = await injectChatGPTPromptViaEditor(gridTabId, frameId, prompts[provider]);
      else if (provider === 'kimi') r = await injectKimiPromptViaLexical(gridTabId, frameId, prompts[provider]);
      if (r) recordHijack(provider, r);
      if (r?.ok) skipInputMap[provider] = true;
    } catch (_) { /* serial submit will retry / handle */ }
  }));

  // Now serial submit-click (each provider's send button click), then
  // launch poll in parallel after all submits done.
  const pollPromises = [];
  for (const provider of submitOrder) {
    if (failed.has(provider) || signal?.aborted) {
      pollPromises.push(Promise.resolve({
        provider, ok: false, error: failed.has(provider) ? 'failed in earlier phase' : 'Pipeline cancelled'
      }));
      continue;
    }
    pollPromises.push((async () => {
      let text = null;
      let lastErr = null;
      const MAX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1) {
            postProvider(provider, stage, { status: 'running', stage: `retry ${attempt - 1}` });
            await reloadProviderFrame(gridTabId, provider);
            if (signal?.aborted) throw new Error('Pipeline cancelled');
            // Re-hijack on retry since iframe reloaded
            const frameId2 = getFrameId(gridTabId, provider);
            if (frameId2 != null) {
              let r2 = null;
              if (provider === 'gemini') r2 = await injectGeminiPromptViaQuill(gridTabId, frameId2, prompts[provider]);
              else if (provider === 'chatgpt') r2 = await injectChatGPTPromptViaEditor(gridTabId, frameId2, prompts[provider]);
              else if (provider === 'kimi') r2 = await injectKimiPromptViaLexical(gridTabId, frameId2, prompts[provider]);
              if (r2) recordHijack(provider, r2);
              skipInputMap[provider] = !!r2?.ok;
            }
          }
          text = await submitAndPollOnce(provider, prompts[provider], !!skipInputMap[provider]);
          break;
        } catch (err) {
          lastErr = err;
          const msg = err?.message ?? String(err);
          const isTransient =
            /No assistant text appeared|Empty output|submit failed|message channel closed|Receiving end does not exist|Generation did not complete|Probe failed|swWaitUntil timeout/i.test(msg);
          const isCancelled = signal?.aborted || /Pipeline cancelled/.test(msg);
          if (isCancelled || !isTransient || attempt === MAX_ATTEMPTS) break;
        }
      }
      if (text != null) {
        const elapsedMs = Date.now() - (startTimes[provider] ?? startedAt);
        postProvider(provider, stage, { status: 'done', output: text, elapsedMs });
        return { provider, ok: true, output: text, elapsedMs };
      }
      const error = lastErr?.message ?? String(lastErr);
      postProvider(provider, stage, { status: 'failed', error });
      return { provider, ok: false, error };
    })());
    // Small stagger between starting each provider's submit-click to avoid
    // the parallel-click contention that breaks Gemini.
    await swSleep(400);
  }

  return await Promise.all(pollPromises);
}


// =================== Prompt templates ===================

function formatHistory(history) {
  if (!history || history.length === 0) return '';
  return history
    .map(m => (m.role === 'user' ? '用户' : '助手') + '：' + m.content)
    .join('\n\n---\n\n');
}

function historyBlock(history) {
  const txt = formatHistory(history);
  return txt
    ? `<conversation_history>\n${txt}\n</conversation_history>\n\n`
    : '';
}

function buildR1Prompt(userPrompt, history = []) {
  return `你是一个独立分析 agent。不要引用其他模型观点，因为你现在看不到它们。

${historyBlock(history)}本轮用户问题：
${userPrompt}

请严格按以下格式输出：

<answer>
核心结论：
（一两句话直接给出你的判断）

关键推理：
1. ...
2. ...
3. ...

可能的盲点：
1. ...
2. ...

我最不确定的地方：
（你自己最没把握的一个点）

最终建议：
（用户应该如何采取行动）
</answer>`;
}

// =================== R2 roles ===================
//
// In R2 each provider plays a distinct cognitive role so cross-review
// produces real divergence rather than four polite reformulations of the
// same answer. Each role has explicit anti-fluff guards specific to its
// failure mode (LLMs default to smooth-sounding platitudes).

const R2_ROLES = {
  '缝合怪': `你是缝合怪。不生产观点，只做代码/逻辑的无情搬运工——把三家答案里最实用的零件强行缝起来，不在乎风格统一。

具体输出：
1. 列每家答案最值得保留的 1-2 个具体观点（**引用原话**，不准换措辞）
2. 把这些观点拼成一份新答案，最短最直接

禁忌：不要润色冲突；不要平衡观点；不要解释为啥这么缝。`,

  '杠精': `你是杠精。默认所有方案都是垃圾。核心任务是阴阳怪气地挑出致命漏洞，不服就干。

具体输出：
1. 找每家答案里最经不起推敲的 1 个**具体论断**（不是模糊立场）
2. 给反驳理由（反例 / 反面证据 / 自相矛盾处）
3. 用最直接的语气，不和稀泥

禁忌：
- 严禁"也有道理但是..."、"辩证地看"这种平衡腔
- 挑不出毛病就直接说"这一点我承认挑不出问题"，**不准硬编"补充"**`,

  '懂王': `你是懂王。极度偏执，眼里揉不得沙子，永远追问"本质是什么"，把表面问题扒得只剩底裤。

具体输出：
1. 这问题的**不可约束核心约束**是什么（物理 / 经济 / 时间 / 信息 / 信任 / 注意力 — 哪一类，几个）
2. 三家答案里有没有人**在回答错的问题**？指出他们的 hidden assumption
3. 抛开他们的回答，从核心约束重新推导 — 真正的答案应该是什么

严禁（你这角色最容易翻车的地方，LLM 在"第一性原理"上特别容易退化成顺滑废话）：
- 严禁车轱辘话（"问题的本质是问题的本质"）
- 严禁假大空哲学口号（"关键在于执行" / "找到平衡点" / "一切皆有可能" / "因人而异"）
- 你给的每个"本质"判断**必须可证伪** — 同时写出"什么情况下我这个判断会被推翻"`,

  '串子': `你是串子。绝不就事论事，喜欢疯狂跨界举例，把历史 / 别的圈子的瓜搬过来强行对比。

具体输出：
1. 找一个看似无关、但**结构相似**的情境（历史事件 / 其他行业 / 其他文化）
2. 那个情境里：发生了什么、谁赢谁输、为什么
3. 跟当前问题最关键的一个**结构性差异** — 这个差异决定了能不能直接套用

禁忌：
- 不要列三个泛泛类比 — 选一个，讲透
- 不要把类比当结论 — 要把"差异"讲清楚`,

  '打工人': `你是打工人。极其务实且不耐烦，讨厌一切宏大叙事，只甩出"明天早起第一步先干啥"的说明书。

具体输出：
1. 用户**明早 9 点**起来，第一件事具体干什么（具体到打开哪个 app / 给谁发什么消息 / 写下哪几行字）
2. 这一步花多久、需要什么、可能在哪卡住
3. 完成的标志是什么（能用什么验证 done 而不是 doing）

严禁（你这角色最容易翻车的地方，LLM 在"实操建议"上特别容易退化成正确的废话）：
- 严禁"正确的废话"（"循序渐进" / "保持耐心" / "做好规划" / "重视执行"）
- 严禁列 7 步五年计划 — **最多到第三步**，重点是第一步
- 每一步必须是可执行**动作**（"考虑 X" 不算，"打开 X 写下 Y" 才算）`
};

const DEFAULT_ROLE_MAPPING = {
  chatgpt:  '杠精',
  deepseek: '懂王',
  kimi:     '打工人',
  gemini:   '串子'
};

function buildR2Prompt(userPrompt, selfProvider, r1Outputs, history = [], roleId) {
  const others = ALL_PROVIDERS
    .filter(p => p !== selfProvider && r1Outputs[p])
    .map(p => `<answer provider="${p}">\n${r1Outputs[p]}\n</answer>`)
    .join('\n\n');

  const selfAnswer = r1Outputs[selfProvider] ?? '(missing)';
  const rolePrompt = R2_ROLES[roleId];

  // Fallback to the original generic R2 if role unknown (defensive)
  if (!rolePrompt) {
    return `你是交叉评审 agent。看完三家答案后，给出你的修正版回答。

${historyBlock(history)}本轮用户问题：
${userPrompt}

你的第一轮回答：
<self_answer>${selfAnswer}</self_answer>

其他模型回答：
${others}

请输出修正后的完整回答。`;
  }

  return `${historyBlock(history)}原始问题：
${userPrompt}

三家的第一轮答案如下：

<answer provider="${selfProvider}" self="true">
${selfAnswer}
</answer>

${others}

---

你扮演的角色：**${roleId}**

${rolePrompt}

---

请按你这个角色的立场，看完三家答案后输出你的 R2。
不要被"应该公平评估每家"绑架——你就是这个角色，按角色该说的方式说。`;
}

function buildFinalPrompt(userPrompt, r2Outputs, history = [], roleMapping = {}) {
  const sections = ALL_PROVIDERS
    .filter(p => r2Outputs[p])
    .map(p => {
      const role = roleMapping[p];
      const roleAttr = role ? ` role="${role}"` : '';
      return `<r2 provider="${p}"${roleAttr}>\n${r2Outputs[p]}\n</r2>`;
    })
    .join('\n\n');

  return `你是最终主编。你的任务不是平均三份答案，而是判断、去重、合并、裁剪、解决矛盾。把读者当成只读你这一份输出的人——他们看不到上面三份原文，也看不到 R1/R2 的内部结构。

${historyBlock(history)}本轮用户问题：
${userPrompt}

三份第二轮回答如下（每家在 R2 扮演了一个角色，看 \`role\` 属性。它们的语气和侧重是**故意倾斜**的，你需要据此判断各家的偏向，不要被任何单方说服）：

${sections}

输出格式要求（必须严格遵守，否则下游渲染会失败）：

1. 每个分节标题**必须**以 \`# \`（井号 + 空格）开头。例如写 \`# 最终结论\`，不要只写"最终结论"或加冒号。
2. 重点词语用 \`**xxx**\` 包起来加粗，例如 \`**规模优势**\`。
3. 列表用 \`- \` 或 \`1. \` 开头。
4. 不要在输出最外层包 \`<answer>\`、\`<revision>\` 等任何 XML 标签——这是给最终用户的，不是给下游 agent 的。

请严格按以下六个分节输出（顺序固定，标题文字一字不差）：

# 最终结论
（一两句话直接给答案，不要套话）

# 综合答案
（完整、可读、自包含的回答正文。这是用户实际要看的内容；可以再分小节用 \`## 子标题\`，可以用列表）

# 三个模型的主要共识
（哪些点三家都赞成，列表形式）

# 主要分歧与裁决
（哪些点有分歧，你作为主编最终选择哪一边，给理由）

# 可执行方案
（如果适用：用户下一步该做什么；列表形式）

# 仍需验证的信息
（哪些事实/前提还没确认，用户应该自己核实哪些；列表形式）`;
}

// =================== Full pipeline orchestrator ===================

let activePipelineAbort = null;

async function runFullPipeline(userPrompt, history = [], enabledProviders, finalEditorOverride, roleMapping, signal) {
  const providers = (Array.isArray(enabledProviders) && enabledProviders.length > 0)
    ? enabledProviders.filter(p => PROVIDERS[p])
    : ALL_PROVIDERS;

  if (providers.length < 2) {
    throw new Error(`Need at least 2 providers enabled (got ${providers.length})`);
  }

  const finalEditor =
    (finalEditorOverride && PROVIDERS[finalEditorOverride])
      ? finalEditorOverride
      : pickFinalEditor(providers);

  // Merge user-provided role mapping over defaults so unmapped providers fall back
  const roles = { ...DEFAULT_ROLE_MAPPING, ...(roleMapping || {}) };

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('Pipeline cancelled');
  };

  // Round 1 (no role — independent baseline answer)
  checkAbort();
  const r1Prompt = buildR1Prompt(userPrompt, history);
  const r1Prompts = Object.fromEntries(providers.map(p => [p, r1Prompt]));
  const r1Results = await runStage({
    providers, prompts: r1Prompts, stage: 'r1', signal
  });

  const r1Outputs = {};
  for (const r of r1Results) {
    if (r.ok) r1Outputs[r.provider] = r.output;
  }
  const r1Survivors = Object.keys(r1Outputs);
  if (r1Survivors.length < 2) {
    throw new Error(`R1 only produced ${r1Survivors.length} valid output(s); need ≥2 to proceed`);
  }

  // Round 2 — each surviving provider plays its assigned role
  checkAbort();
  const r2Prompts = {};
  for (const p of r1Survivors) {
    r2Prompts[p] = buildR2Prompt(userPrompt, p, r1Outputs, history, roles[p]);
  }
  const r2Results = await runStage({
    providers: r1Survivors, prompts: r2Prompts, stage: 'r2', signal
  });

  const r2Outputs = {};
  for (const r of r2Results) {
    if (r.ok) r2Outputs[r.provider] = r.output;
  }
  if (Object.keys(r2Outputs).length < 2) {
    throw new Error('R2 produced too few outputs to synthesize');
  }

  // Final — synthesizer sees role labels on each R2 so it knows the bias direction
  checkAbort();
  const finalPrompt = buildFinalPrompt(userPrompt, r2Outputs, history, roles);
  const finalResults = await runStage({
    providers: [finalEditor], prompts: { [finalEditor]: finalPrompt }, stage: 'final', signal
  });

  return {
    r1: r1Results,
    r2: r2Results,
    final: finalResults[0],
    roles
  };
}

// =================== iPhone → ChatGPT → WhatsApp relay ===================
//
// Long-polls Telegram for photos sent by an allowed user, drops them into a
// dedicated ChatGPT tab with a fixed prompt, waits for the answer to stabilise,
// then opens web.whatsapp.com/send and lets whatsapp_inject.js auto-send it.
//
// Settings live in chrome.storage.local under the keys defined below; the
// sidepanel exposes a small UI for filling them in. The relay survives SW
// restarts via chrome.alarms (the SW is woken once a minute and re-arms the
// poller if it's not running but the user enabled it).

const RELAY_KEYS = {
  enabled:          'tgRelay.enabled',
  token:            'tgRelay.token',
  allowedUserId:    'tgRelay.allowedUserId',
  allowedChannelId: 'tgRelay.allowedChannelId',
  prompt:           'tgRelay.prompt',
  waPhone:          'tgRelay.waPhone',
  destTelegram:     'tgRelay.destTelegram',
  destWhatsapp:     'tgRelay.destWhatsapp',
  keepTabs:         'tgRelay.keepTabs',
  // Pipeline state for SW-death recovery and dedup.
  queue:            'tgRelay.queue',      // [batch] — waiting to be processed
  inFlight:         'tgRelay.inFlight',   // batch | null — being processed when SW last alive
  processed:        'tgRelay.processed',  // { batchId: completedAt } — dedup ring
  lastAnswer:       'tgRelay.lastAnswer', // { text, batchId, chatId, ts, ... }
};

// How long a queued batch may sit before recovery drops it. Useful so that
// if you shut down for the night, yesterday's images don't suddenly auto-run
// at 9am when the SW wakes up.
const RELAY_QUEUE_MAX_AGE_MS = 30 * 60 * 1000;
const RELAY_PROCESSED_KEEP = 100;
const RELAY_MAX_ATTEMPTS = 3;

const RELAY_DEFAULT_PROMPT =
  '这是一份公开的练习卷，请你提供可以直接作为标准阅卷参考的"满分版"解答：\n' +
  '\n' +
  '步骤详尽：给出包含所有中间计算和引用定理的完整推导过程。\n' +
  '逻辑严密：步骤之间需有清晰的逻辑推导衔接。\n' +
  '\n' +
  '【输出格式硬性要求 — 答案会被发到即时通讯软件，必须照做】\n' +
  '1. 严禁使用 LaTeX。不要写 \\frac \\sum \\int \\sqrt \\cdot ^{} _{} 这类语法。\n' +
  '   所有数学符号请直接用 Unicode 字符：\n' +
  '   分数 → 直接写 (a)/(b) 或 ½ ⅓ ¼；\n' +
  '   积分 → ∫ ∮；求和 → ∑；连乘 → ∏；根号 → √；\n' +
  '   上标 → ¹ ² ³ ⁰ ⁿ；下标 → ₁ ₂ ₙ；\n' +
  '   ± × ÷ · ≈ ≠ ≤ ≥ ∞ ∈ ∉ ∋ ⊂ ⊃ ∪ ∩ ∅ ∀ ∃ ⇒ ⇔ → ← ↔；\n' +
  '   希腊字母直接用 α β γ δ ε θ λ μ π σ φ ψ ω Δ Σ Π Ω；\n' +
  '   矩阵/向量请用横向描述，例如 v = (1, 2, 3)。\n' +
  '2. 严禁使用 markdown 标题（# ## ### 一律禁止）。需要分小节时用粗体行：**1. 题目分析** 这种形式。\n' +
  '3. 段落之间最多空一行。不要为了好看插大量空行。\n' +
  '4. 答题语言：中文。';

let relay = null;            // TelegramRelay instance (may be null)
let relayTabId = null;       // dedicated ChatGPT tab for the relay
let relayWindowId = null;    // window hosting the ChatGPT tab (own window so SSE isn't throttled)
let relayWaTabId = null;     // dedicated WhatsApp Web tab
let relayWaWindowId = null;  // window hosting the WhatsApp tab
let relayBusy = false;       // serialise concurrent batches (in-memory only — storage holds the source of truth)
const relayLog = [];         // ring buffer of recent log lines for the UI

// =================== Pipeline persistence helpers ===================

function batchIdFor(batch) {
  // chat + first-msg id is unique per Telegram channel batch. We also fall
  // back to a timestamp if something weird sneaks through (shouldn't).
  return `${batch.chatId}:${batch.msgId ?? batch.queuedAt ?? Date.now()}`;
}

async function queueLoad() {
  const r = await chrome.storage.local.get(RELAY_KEYS.queue);
  return Array.isArray(r[RELAY_KEYS.queue]) ? r[RELAY_KEYS.queue] : [];
}
async function queueSave(arr) {
  await chrome.storage.local.set({ [RELAY_KEYS.queue]: arr });
}

async function inFlightLoad() {
  const r = await chrome.storage.local.get(RELAY_KEYS.inFlight);
  return r[RELAY_KEYS.inFlight] || null;
}
async function inFlightSet(batch) {
  await chrome.storage.local.set({ [RELAY_KEYS.inFlight]: batch || null });
}

async function isProcessedId(id) {
  const r = await chrome.storage.local.get(RELAY_KEYS.processed);
  return !!(r[RELAY_KEYS.processed]?.[id]);
}
async function markProcessed(id) {
  const r = await chrome.storage.local.get(RELAY_KEYS.processed);
  const m = r[RELAY_KEYS.processed] || {};
  m[id] = Date.now();
  // Trim — keep newest N entries.
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, RELAY_PROCESSED_KEEP);
  await chrome.storage.local.set({ [RELAY_KEYS.processed]: Object.fromEntries(entries) });
}

// Recover any work the previous SW life left behind.
async function recoverRelayState() {
  const inFlight = await inFlightLoad();
  let queue = await queueLoad();
  if (inFlight) {
    // SW died mid-flight; put it back at the head for a fresh attempt.
    queue.unshift(inFlight);
    await inFlightSet(null);
  }
  // Drop stale batches (older than RELAY_QUEUE_MAX_AGE_MS).
  const now = Date.now();
  const fresh = queue.filter(b => now - (b.queuedAt ?? now) < RELAY_QUEUE_MAX_AGE_MS);
  const dropped = queue.length - fresh.length;
  await queueSave(fresh);
  if (dropped) logRelay(`recovery: dropped ${dropped} stale batch(es) (older than ${RELAY_QUEUE_MAX_AGE_MS/60000}min)`);
  if (fresh.length) logRelay(`recovery: ${fresh.length} batch(es) queued, attempting to resume`);
  // Kick the drain loop on next tick.
  setTimeout(() => drainQueueIfIdle().catch(err => logRelay(`recovery drain crash: ${err.message ?? err}`)), 500);
  return fresh.length;
}

async function drainQueueIfIdle() {
  if (relayBusy) return;
  const q = await queueLoad();
  if (q.length === 0) return;
  const next = q.shift();
  await queueSave(q);
  handleRelayBatch(next).catch(err => logRelay(`drain crash: ${err.message ?? err}`));
}

function logRelay(line) {
  const ts = new Date().toISOString().slice(11, 19);
  const entry = `[${ts}] ${line}`;
  relayLog.push(entry);
  if (relayLog.length > 80) relayLog.shift();
  try { console.log('[relay]', entry); } catch (_) {}
}

async function getRelayConfig() {
  const stored = await chrome.storage.local.get(Object.values(RELAY_KEYS));
  // Default both destinations on for new installs; if either was explicitly
  // set false earlier, honor that.
  const destTg = stored[RELAY_KEYS.destTelegram];
  const destWa = stored[RELAY_KEYS.destWhatsapp];
  return {
    enabled:          !!stored[RELAY_KEYS.enabled],
    token:            stored[RELAY_KEYS.token] || '',
    allowedUserId:    stored[RELAY_KEYS.allowedUserId] || null,
    allowedChannelId: stored[RELAY_KEYS.allowedChannelId] || null,
    prompt:           stored[RELAY_KEYS.prompt] || RELAY_DEFAULT_PROMPT,
    waPhone:          stored[RELAY_KEYS.waPhone] || '',
    destTelegram:     destTg === undefined ? true : !!destTg,
    destWhatsapp:     destWa === undefined ? true : !!destWa,
    keepTabs:         !!stored[RELAY_KEYS.keepTabs],
  };
}

async function startRelayFromConfig() {
  const cfg = await getRelayConfig();
  if (!cfg.enabled) { logRelay('relay disabled'); return false; }
  if (!cfg.token)   { logRelay('relay: no token configured'); return false; }
  if (!cfg.waPhone) { logRelay('relay: no WhatsApp phone configured'); return false; }

  if (relay && relay.running) {
    logRelay('relay: already running');
    return true;
  }
  relay = new TelegramRelay({
    token: cfg.token,
    allowedUserId: cfg.allowedUserId ? Number(cfg.allowedUserId) : null,
    allowedChannelId: cfg.allowedChannelId ? Number(cfg.allowedChannelId) : null,
    onLog: logRelay,
    onBatch: (batch) => handleRelayBatch(batch).catch(err => {
      logRelay(`batch handler crash: ${err.message ?? err}`);
    })
  });
  await relay.start();
  return true;
}

function stopRelay() {
  if (relay) {
    relay.stop();
    relay = null;
  }
}

async function handleRelayBatch(batch) {
  // Normalise: every batch has an id, a queuedAt, and an attempt counter.
  if (!batch.batchId)      batch.batchId = batchIdFor(batch);
  if (!batch.queuedAt)     batch.queuedAt = Date.now();
  if (!batch.attemptCount) batch.attemptCount = 0;

  // Dedup: if we already finished this exact batch, drop on the floor.
  if (await isProcessedId(batch.batchId)) {
    logRelay(`batch ${batch.batchId} already processed — skipping duplicate`);
    return;
  }

  // If currently busy, persist to storage queue and return.
  if (relayBusy) {
    const q = await queueLoad();
    q.push(batch);
    await queueSave(q);
    logRelay(`batch queued (busy): ${batch.images.length} photos · queue=${q.length}`);
    if (relay) await relay.sendText(batch.chatId,
      `📋 Queued behind current batch (${q.length} ahead) — will process automatically.`);
    return;
  }

  relayBusy = true;
  await inFlightSet(batch);
  const cfg = await getRelayConfig();

  try {
    // Wall-clock safety net: no single batch may pin the queue for more than
    // BATCH_HARD_TIMEOUT_MS, no matter what hangs inside (tab unresponsive,
    // executeScript stuck, etc.). Promise.race lets us bail out and free the
    // queue even if internal awaits never resolve.
    const BATCH_HARD_TIMEOUT_MS = 12 * 60 * 1000; // 12 min
    await Promise.race([
      processBatchWithRetries(batch, cfg),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error(`batch wall-clock timeout (${BATCH_HARD_TIMEOUT_MS/60000} min)`)),
        BATCH_HARD_TIMEOUT_MS
      )),
    ]);
    await markProcessed(batch.batchId);
  } catch (err) {
    logRelay(`batch ${batch.batchId} ultimately failed: ${err.message ?? err}`);
    if (relay) await relay.sendText(batch.chatId, `❌ Gave up after ${batch.attemptCount} attempt(s): ${err.message ?? err}`);
    // Still mark processed so we don't infinite-loop on the same bad batch
    // after SW restart. User can resend manually if they want.
    await markProcessed(batch.batchId);
  } finally {
    relayBusy = false;
    await inFlightSet(null);

    // Drain next from the storage queue.
    const remaining = await queueLoad();
    if (remaining.length > 0) {
      const next = remaining.shift();
      await queueSave(remaining);
      logRelay(`relay: starting next queued batch (${remaining.length} still queued)`);
      setTimeout(() => handleRelayBatch(next).catch(err => {
        logRelay(`queued batch crash: ${err.message ?? err}`);
      }), 100);
    } else if (!cfg.keepTabs) {
      setTimeout(closeRelayTabs, 3000);
    } else {
      logRelay('relay: keepTabs on — leaving windows open for inspection');
    }
  }
}

// Runs one batch, retrying ChatGPT-side failures with exponential backoff.
// Delivery failures handle their own retries inside deliverAnswer.
async function processBatchWithRetries(batch, cfg) {
  let lastErr;
  while (batch.attemptCount < RELAY_MAX_ATTEMPTS) {
    batch.attemptCount++;
    await inFlightSet(batch); // persist updated counter
    try {
      await processBatch(batch, cfg);
      return; // success
    } catch (err) {
      lastErr = err;
      const isLast = batch.attemptCount >= RELAY_MAX_ATTEMPTS;
      logRelay(`batch ${batch.batchId} attempt ${batch.attemptCount}/${RELAY_MAX_ATTEMPTS} failed: ${err.message ?? err}${isLast ? ' — giving up' : ''}`);
      if (relay && !isLast) {
        await relay.sendText(batch.chatId,
          `⚠️ Attempt ${batch.attemptCount}/${RELAY_MAX_ATTEMPTS} failed: ${err.message ?? err}\nRetrying...`);
      }
      if (isLast) break;
      // Exponential backoff: 5s, 15s
      const wait = 5000 * Math.pow(3, batch.attemptCount - 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Common ChatGPT error / refusal strings (case-insensitive substrings).
// If the answer matches one of these, treat the whole batch as failed and retry.
const CHATGPT_ERROR_PATTERNS = [
  /something went wrong/i,
  /please try again/i,
  /try again later/i,
  /network error/i,
  /you're sending messages too quickly/i,
  /rate.?limit/i,
  /i'?m sorry,?\s*but/i,
  /i can'?t (help|assist) with/i,
  /unable to (process|help|assist)/i,
  /无法处理/,
  /出错了/,
  /稍后再试/,
  /请稍后/,
  /出现了一个错误/,
];

// Decide whether a polled answer should be accepted or rejected (→ retry).
// Returns { ok: true } or { ok: false, reason: '...' }.
function classifyAnswer(text, imageCount) {
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length < 30) return { ok: false, reason: 'too short (<30)' };

  // Error-string blacklist — only triggers if the answer is *also* short.
  // A long answer that happens to contain "please try again" near the end
  // (e.g. as advice) shouldn't be rejected.
  if (text.length < 600) {
    for (const re of CHATGPT_ERROR_PATTERNS) {
      if (re.test(text)) return { ok: false, reason: `error string: ${re}` };
    }
  }

  // Multi-image low-density heuristic: ≥3 images but very few chars/image
  // strongly suggests ChatGPT errored out or only solved 1 of N.
  if (imageCount >= 3) {
    const perImg = text.length / imageCount;
    if (perImg < 80) {
      return { ok: false, reason: `low density (${Math.round(perImg)} chars/img, expected ≥80)` };
    }
  }

  return { ok: true };
}

async function processBatch(batch, cfg) {
  const prompt = batch.caption?.trim() || cfg.prompt;
  if (relay) await relay.sendText(batch.chatId,
    `⏳ Got ${batch.images.length} photo(s) — running ChatGPT (attempt ${batch.attemptCount}/${RELAY_MAX_ATTEMPTS})...`);

  const tabId = await getOrCreateRelayChatgptTab();
  await waitForChatgptReady(tabId);

  logRelay(`sending ${batch.images.length} images to ChatGPT (tab ${tabId})`);
  const submitRes = await sendMessageToTopFrame(tabId, {
    type: 'SUBMIT_WITH_ATTACHMENTS',
    prompt,
    images: batch.images
  });
  if (!submitRes?.ok) throw new Error('submit failed: ' + (submitRes?.error || 'unknown'));
  if (submitRes.attach) logRelay(`attach: ${submitRes.attach.count} files via ${submitRes.attach.strategy}`);

  const answer = await pollChatgptAnswer(tabId);
  const verdict = classifyAnswer(answer, batch.images.length);
  if (!verdict.ok) {
    throw new Error(`ChatGPT answer rejected: ${verdict.reason} (${answer?.length ?? 0} chars, ${batch.images.length} imgs)`);
  }

  logRelay(`got answer (${answer.length} chars), delivering`);

  // Cache answer immediately — even if both deliveries fail, the user can
  // resend from sidepanel without re-burning ChatGPT.
  await chrome.storage.local.set({
    [RELAY_KEYS.lastAnswer]: {
      text: answer,
      batchId: batch.batchId,
      chatId: batch.chatId,
      ts: Date.now(),
      source: batch.source,
      imageCount: batch.images.length,
      prompt: prompt.slice(0, 200),
    }
  });

  if (relay) await relay.sendText(batch.chatId, `✅ ChatGPT done (${answer.length} chars). Delivering...`);
  await deliverAnswer(answer, batch.chatId, cfg);
}

// Per-destination retry helper. Each destination gets its own retries so a
// transient WhatsApp failure doesn't keep Telegram from succeeding.
async function deliverAnswer(answer, replyChatId, cfg) {
  const tasks = [];
  if (cfg.destTelegram) {
    tasks.push(retryAsync(
      async () => {
        const r = await relay.sendAnswerHtml(replyChatId, answer);
        return { dest: 'telegram', ok: true, info: `${r.chunks} chunk(s)` };
      },
      { tries: 3, baseDelayMs: 3000, label: 'telegram' }
    ).catch(err => ({ dest: 'telegram', ok: false, error: err.message ?? String(err) })));
  }
  if (cfg.destWhatsapp) {
    tasks.push(retryAsync(
      async () => {
        if (!cfg.waPhone) throw new Error('no WhatsApp phone configured');
        const r = await deliverToWhatsapp(cfg.waPhone, answer);
        if (!r.ok) throw new Error(r.error || 'unknown');
        return { dest: 'whatsapp', ok: true };
      },
      { tries: 3, baseDelayMs: 5000, label: 'whatsapp' }
    ).catch(err => ({ dest: 'whatsapp', ok: false, error: err.message ?? String(err) })));
  }
  if (tasks.length === 0) {
    logRelay('no destinations enabled — answer cached only');
    if (relay) await relay.sendText(replyChatId, '⚠️ No destination enabled in extension settings (answer cached, use sidepanel to resend).');
    return;
  }
  const results = await Promise.all(tasks);
  for (const r of results) {
    if (r.ok) logRelay(`✓ ${r.dest}: ${r.info || 'ok'}`);
    else      logRelay(`✗ ${r.dest}: ${r.error}`);
  }
  const summary = results
    .map(r => `${r.ok ? '✅' : '❌'} ${r.dest}${r.ok ? '' : ' (' + r.error + ')'}`)
    .join(' · ');
  const anyFail = results.some(r => !r.ok);
  if (anyFail) {
    if (relay) await relay.sendText(replyChatId, `${summary}\n💾 Answer cached — use sidepanel "重发上次答案" to retry failed destinations.`);
  } else {
    if (relay) await relay.sendText(replyChatId, summary);
  }
}

async function retryAsync(fn, { tries = 3, baseDelayMs = 3000, label = 'op' } = {}) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (i < tries) {
        const wait = baseDelayMs * i;
        logRelay(`${label} attempt ${i}/${tries} failed (${e.message ?? e}) — retrying in ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw err;
}

async function closeRelayTabs() {
  // Close the whole windows rather than just the tabs — both relay tabs
  // live alone in their own background windows, so removing the window is
  // cleaner and definitely won't leave an orphan window behind.
  const winIds = [relayWindowId, relayWaWindowId].filter(id => id != null);
  if (winIds.length === 0 && relayTabId == null && relayWaTabId == null) return;
  for (const id of winIds) {
    try { await chrome.windows.remove(id); } catch (_) {}
  }
  // Fallback for the legacy path where a tab exists without a tracked window.
  for (const id of [relayTabId, relayWaTabId]) {
    if (id != null) {
      try { await chrome.tabs.remove(id); } catch (_) {}
    }
  }
  logRelay(`relay: closed relay window(s)`);
  relayTabId = null;
  relayWaTabId = null;
  relayWindowId = null;
  relayWaWindowId = null;
}

async function getOrCreateRelayChatgptTab() {
  // Plain new-chat URL (NOT ?temporary-chat=true). Temp-chat mode has been
  // unreliable lately — submissions can hang on the OpenAI side. Trade-off:
  // every batch now leaves history in the user's ChatGPT sidebar.
  const startUrl = 'https://chatgpt.com/';
  if (relayTabId != null) {
    try {
      await chrome.tabs.get(relayTabId);
      // Reset to a fresh chat so each batch is independent.
      await chrome.tabs.update(relayTabId, { url: startUrl, active: false });
      return relayTabId;
    } catch (_) {
      relayTabId = null;
      relayWindowId = null;
    }
  }
  // Open the ChatGPT relay window in the foreground. We can't truly force
  // Chrome to steal focus from another foreground app (Windows blocks
  // SetForegroundWindow from background processes by design), but we do
  // everything an extension is allowed to do:
  //   focused:true + drawAttention:true  → taskbar flashes, user notices
  //   state: maximized                   → next time Chrome comes forward, it's huge
  //   repeated update calls              → occasionally bypasses the lock
  const win = await chrome.windows.create({
    url: startUrl,
    type: 'normal',
    focused: true,
    width: 1280,
    height: 900
  });
  relayWindowId = win.id;
  relayTabId = win.tabs?.[0]?.id ?? null;

  // Belt-and-suspenders: maximize + flash taskbar + retry focus a couple
  // times. drawAttention only works when the window isn't already focused
  // by Windows, so it's the actual signal you'll see if Chrome was hidden.
  try {
    await chrome.windows.update(win.id, {
      focused: true,
      state: 'maximized',
      drawAttention: true
    });
  } catch (_) {}
  // One more retry after a short delay — sometimes Windows accepts the
  // foreground transition only after the window has finished its initial
  // creation animation.
  setTimeout(() => {
    chrome.windows.update(win.id, {
      focused: true,
      drawAttention: true
    }).catch(() => {});
  }, 600);

  return relayTabId;
}

async function waitForChatgptReady(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        // Confirm content script is alive by trying to invoke the poll fn.
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => typeof window.__multiAIPollState === 'function'
        });
        if (result) return;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('ChatGPT tab not ready within timeout');
}

async function sendMessageToTopFrame(tabId, message) {
  // chrome.tabs.sendMessage broadcasts to all frames; targeting top frame
  // by frameId 0 makes sure only content_adapter.js (which only registers
  // when isDirectChildOfTop) receives it.
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    });
  });
}

async function pollChatgptAnswer(tabId, { timeoutMs = 10 * 60 * 1000 } = {}) {
  // Three "done" detection paths, tried in order each tick:
  //
  // (1) Standard ChatGPT (GPT-4o etc.): the assistant bubble carries
  //     data-message-status. Terminal value → done immediately.
  // (2) Reasoning models (o1/o3/o4 "Thought for X"): no status attribute.
  //     The answer appears in one burst AFTER the stop button disappears,
  //     with a real lag between "thinking done" and "answer visible in DOM"
  //     that exceeded our old 18s stability window. We instead watch the
  //     assistant message's RAW textContent length — once it stops growing
  //     for NO_GROWTH_DONE_MS, we're done.
  // (3) Hard timeout safety net.
  const TERMINAL_STATUSES = new Set([
    'finished_successfully',
    'finished_partial_completion',
    'finished_partial_image_generation',
    'finished_safety',
    'finished',
  ]);
  const STREAMING_STATUSES = new Set([
    'streaming',
    'in_progress',
    'finished_pending_continuation',
  ]);
  const POLL_MS = 1500;
  const NO_GROWTH_DONE_MS = 60000;  // 60s of no textContent growth → done
  const MIN_TEXT_TO_FINISH = 50;     // never finish on a near-empty bubble

  const start = Date.now();
  let peakLen = 0;
  let lastGrowthAt = Date.now();
  let lastResult = null;
  let firstSeenAt = 0;
  let lastStateKey = '';

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let result;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => window.__multiAIPollState ? window.__multiAIPollState() : { error: 'no_poll_fn' }
      });
      result = r?.[0]?.result;
    } catch (e) {
      continue; // tab transitioning
    }
    if (!result || result.error) continue;
    lastResult = result;
    if ((result.fullTextLen || result.text) && !firstSeenAt) {
      firstSeenAt = Date.now();
    }

    // textContent length is the ground truth for "is the bubble growing".
    // Reset growth timer on any increase — even 1 byte counts.
    const fullLen = result.fullTextLen || 0;
    if (fullLen > peakLen) {
      peakLen = fullLen;
      lastGrowthAt = Date.now();
    }

    // Diagnostic log on state transition.
    const stateKey = `${result.messageStatus ?? 'null'}|stream=${result.streaming}|stop=${result.stopVisible}|reason=${!!result.reasoning}|analyzing=${!!result.analyzingImages}|msgs=${result.messageCount}`;
    if (stateKey !== lastStateKey) {
      logRelay(`poll: status=${result.messageStatus ?? 'null'} stream=${result.streaming} stop=${result.stopVisible} reason=${!!result.reasoning} analyzing=${!!result.analyzingImages} msgs=${result.messageCount} text=${result.text?.length ?? 0}c full=${fullLen}c peak=${peakLen}c`);
      lastStateKey = stateKey;
    }

    // (1) Authoritative status, if present.
    if (result.messageStatus) {
      if (TERMINAL_STATUSES.has(result.messageStatus)) {
        logRelay(`poll: terminal status "${result.messageStatus}" — done`);
        return result.text;
      }
      if (STREAMING_STATUSES.has(result.messageStatus)) {
        lastGrowthAt = Date.now(); // keep timer reset while explicitly streaming
        continue;
      }
    }

    // Still working — reset the no-growth timer.
    if (result.streaming || result.stopVisible || result.reasoning || result.analyzingImages) {
      lastGrowthAt = Date.now();

      // EARLY-ABORT for hung image analysis: if "正在分析" has been visible
      // with NO real answer text growing for ANALYZING_HANG_MS, the vision
      // backend is stalled — abort so the batch can retry with a fresh tab
      // (much faster than waiting 10 min for the full timeout).
      const ANALYZING_HANG_MS = 4 * 60 * 1000;
      if (result.analyzingImages && peakLen < MIN_TEXT_TO_FINISH && Date.now() - start > ANALYZING_HANG_MS) {
        throw new Error(`stuck on "正在分析" for ${(Date.now()-start)/60000 | 0} min with no answer text`);
      }
      continue;
    }

    // (2) Heuristic done: no stream/stop indicator + no textContent growth
    // for NO_GROWTH_DONE_MS + we have at least SOMETHING.
    if (peakLen >= MIN_TEXT_TO_FINISH && Date.now() - lastGrowthAt > NO_GROWTH_DONE_MS) {
      logRelay(`poll: no growth ${(Date.now() - lastGrowthAt)/1000 | 0}s, peak=${peakLen}c — done`);
      return result.text;
    }

    // Safety: if 3 min elapsed without ANY text appearing, give up.
    if (!firstSeenAt && Date.now() - start > 180000) {
      throw new Error('ChatGPT produced no text in 3 min');
    }
  }
  if (lastResult?.text) return lastResult.text;
  throw new Error('answer poll timed out');
}

async function deliverToWhatsapp(phone, text) {
  const cleanPhone = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  const url = `https://web.whatsapp.com/send?phone=${cleanPhone}`;

  if (relayWaTabId != null) {
    try {
      await chrome.tabs.get(relayWaTabId);
      await chrome.tabs.update(relayWaTabId, { url, active: false });
    } catch (_) {
      relayWaTabId = null;
      relayWaWindowId = null;
    }
  }
  if (relayWaTabId == null) {
    // Same dedicated-window trick as ChatGPT — keeps the tab visible so
    // WA Web's send pipeline doesn't get throttled while we're not
    // looking at it.
    const win = await chrome.windows.create({
      url,
      type: 'normal',
      focused: false,
      width: 1280,
      height: 900
    });
    relayWaWindowId = win.id;
    relayWaTabId = win.tabs?.[0]?.id ?? null;
  }

  // Wait for tab to finish loading before talking to the content script.
  await waitForTabComplete(relayWaTabId, 30000);

  // The content script may not be ready immediately even after status==complete
  // (WA Web does a long client-side init). Retry sendMessage until it answers.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const r = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(relayWaTabId, { type: 'WHATSAPP_SEND', text }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      });
      if (r?.ok) return { ok: true };
      if (r && r.ok === false) return { ok: false, error: r.error };
    } catch (_) {
      // content script not yet there — keep retrying
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: false, error: 'whatsapp content script never responded' };
}

async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch (_) {
      throw new Error('relay tab disappeared');
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

// Auto-start on SW boot if user previously enabled the relay. Each path also
// runs recoverRelayState() so any batch that was mid-flight or queued when
// the previous SW life ended gets picked up and retried.
async function bootRelay(reason) {
  try {
    await recoverRelayState();
  } catch (err) {
    logRelay(`${reason} recover: ${err.message ?? err}`);
  }
  try {
    await startRelayFromConfig();
  } catch (err) {
    logRelay(`${reason} start: ${err.message ?? err}`);
  }
}

chrome.runtime.onStartup?.addListener(() => { bootRelay('onStartup'); });
chrome.runtime.onInstalled.addListener(() => { bootRelay('onInstalled'); });

// Best-effort wake-up: if SW was killed mid-poll, this re-arms the poller.
try {
  chrome.alarms.create('tg-relay-tick', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== 'tg-relay-tick') return;
    const cfg = await getRelayConfig();
    if (cfg.enabled && (!relay || !relay.running)) {
      bootRelay('alarm');
    } else if (cfg.enabled) {
      // Poller is alive; just check the storage queue in case a batch is
      // sitting there with no one picking it up.
      drainQueueIfIdle().catch(() => {});
    }
  });
} catch (_) {}

// Best-effort cold start: if module re-evaluates on SW wake-up, recover state
// and start the poller.
bootRelay('module-eval');

// =================== Message dispatcher ===================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_PROVIDERS') {
    // Single-stage run (used by debug single-provider buttons).
    // Defaults to R1 with raw user prompt (no template).
    const providers = msg.providers ?? [];
    const prompts = msg.prompts ?? Object.fromEntries(providers.map(p => [p, msg.prompt]));
    runStage({ providers, prompts, stage: msg.stage ?? 'r1' })
      .then(results => sendResponse({ ok: true, results }))
      .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'RUN_FULL_PIPELINE') {
    // Abort any prior in-flight pipeline (shouldn't normally happen but be safe)
    if (activePipelineAbort) activePipelineAbort.abort();
    activePipelineAbort = new AbortController();
    const signal = activePipelineAbort.signal;

    (async () => {
      try {
        const data = await runFullPipeline(
          msg.prompt, msg.history ?? [], msg.providers,
          msg.finalEditor, msg.roleMapping, signal
        );
        sendResponse({ ok: true, ...data });
      } catch (err) {
        const cancelled = signal.aborted || err.message === 'Pipeline cancelled';
        sendResponse({ ok: false, error: err.message ?? String(err), cancelled });
      } finally {
        if (activePipelineAbort?.signal === signal) activePipelineAbort = null;
      }
    })();
    return true;
  }
  if (msg.type === 'CANCEL_PIPELINE') {
    if (activePipelineAbort) {
      activePipelineAbort.abort();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'No active pipeline' });
    }
    return false;
  }
  if (msg.type === 'OPEN_GRID') {
    // Bring the workspace tab to foreground + activate.
    getOrCreateGridTab()
      .then(async tabId => {
        await chrome.tabs.update(tabId, { active: true });
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        } catch (_) {}
        return tabId;
      })
      .then(() => sendResponse({ ok: true, gridTabId }))
      .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'OPEN_CHAT_TAB') {
    // Open chat in dedicated browser window — see openOrFocusChatWindow comment.
    (async () => {
      try {
        const tabId = await openOrFocusChatWindow();
        if (tabId != null) {
          gridTabId = tabId;
          schedulePersistDebug();
        }
        sendResponse({ ok: true, tabId });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'CLEAN_GEMINI_HISTORY') {
    cleanGeminiHistory()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'GRID_STATUS') {
    const map = providerFrames.get(gridTabId) ?? {};
    sendResponse({ ok: true, gridTabId, frames: map });
    return false;
  }
  if (msg.type === 'CONTENT_SCRIPT_REGISTER') {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId != null && frameId != null && msg.provider) {
      let map = providerFrames.get(tabId);
      if (!map) { map = {}; providerFrames.set(tabId, map); }
      map[msg.provider] = frameId;
    }
    return false;
  }
  if (msg.type === 'COLLECT_DEBUG') {
    collectDebug()
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
    return true;
  }
  if (msg.type === 'RELAY_GET_CONFIG') {
    (async () => {
      try {
        const cfg = await getRelayConfig();
        const stored = await chrome.storage.local.get([
          RELAY_KEYS.lastAnswer, RELAY_KEYS.queue, RELAY_KEYS.inFlight
        ]);
        sendResponse({
          ok: true,
          config: cfg,
          running: !!(relay && relay.running),
          log: relayLog.slice(-30),
          lastAnswer: stored[RELAY_KEYS.lastAnswer] || null,
          queueLength: (stored[RELAY_KEYS.queue] || []).length,
          inFlight: !!stored[RELAY_KEYS.inFlight]
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'RELAY_RESEND_LAST') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(RELAY_KEYS.lastAnswer);
        const cached = stored[RELAY_KEYS.lastAnswer];
        if (!cached || !cached.text) {
          sendResponse({ ok: false, error: '没有缓存的答案可重发' });
          return;
        }
        if (relayBusy) {
          sendResponse({ ok: false, error: '当前有 batch 在跑，请等它完成再重发' });
          return;
        }
        const cfg = await getRelayConfig();
        relayBusy = true;
        try {
          logRelay(`resend: replaying cached answer (${cached.text.length} chars) from ${new Date(cached.ts).toLocaleTimeString()}`);
          await deliverAnswer(cached.text, cached.chatId, cfg);
          sendResponse({ ok: true });
        } finally {
          relayBusy = false;
          // Don't drain queue here — that's the poller's job.
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'RELAY_CLEAR_QUEUE') {
    (async () => {
      try {
        await queueSave([]);
        await inFlightSet(null);
        // CRITICAL: also reset the in-memory busy flag. Otherwise if a
        // previous batch hung mid-flight, the SW is still alive with
        // relayBusy=true and new batches will keep queueing forever.
        relayBusy = false;
        logRelay('relay: queue cleared + busy flag reset by user');
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'RELAY_UNSTICK') {
    (async () => {
      try {
        await inFlightSet(null);
        relayBusy = false;
        logRelay('relay: manual unstick — busy flag reset, queue preserved');
        // Try to drain whatever is still queued.
        const q = await queueLoad();
        if (q.length > 0) {
          const next = q.shift();
          await queueSave(q);
          logRelay(`relay: resuming queued batch (${q.length} still queued)`);
          setTimeout(() => handleRelayBatch(next).catch(e =>
            logRelay(`unstick drain crash: ${e.message ?? e}`)), 100);
        }
        sendResponse({ ok: true, queueLength: q.length });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'RELAY_SET_CONFIG') {
    (async () => {
      try {
        const patch = msg.patch || {};
        const out = {};
        if (typeof patch.enabled === 'boolean') out[RELAY_KEYS.enabled] = patch.enabled;
        if (typeof patch.token === 'string')    out[RELAY_KEYS.token] = patch.token.trim();
        if ('allowedUserId' in patch) {
          const v = patch.allowedUserId;
          out[RELAY_KEYS.allowedUserId] = v === '' || v == null ? null : Number(v);
        }
        if ('allowedChannelId' in patch) {
          const v = patch.allowedChannelId;
          out[RELAY_KEYS.allowedChannelId] = v === '' || v == null ? null : Number(v);
        }
        if (typeof patch.prompt === 'string')   out[RELAY_KEYS.prompt] = patch.prompt;
        if (typeof patch.waPhone === 'string')  out[RELAY_KEYS.waPhone] = patch.waPhone.trim();
        if (typeof patch.destTelegram === 'boolean') out[RELAY_KEYS.destTelegram] = patch.destTelegram;
        if (typeof patch.destWhatsapp === 'boolean') out[RELAY_KEYS.destWhatsapp] = patch.destWhatsapp;
        if (typeof patch.keepTabs === 'boolean')     out[RELAY_KEYS.keepTabs] = patch.keepTabs;
        await chrome.storage.local.set(out);
        // Re-arm: stop existing instance, start fresh if enabled.
        stopRelay();
        const started = await startRelayFromConfig();
        sendResponse({ ok: true, running: started });
      } catch (err) {
        sendResponse({ ok: false, error: err.message ?? String(err) });
      }
    })();
    return true;
  }
});

