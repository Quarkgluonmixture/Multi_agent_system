chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

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

const ourTabs = new Map();

// =================== Grid (iframe) mode registry ===================
//
// In the new iframe-based architecture, all 4 AI sites run as iframes inside
// a single grid.html tab. Each iframe's content script registers itself on
// load via CONTENT_SCRIPT_REGISTER, so SW can map provider → frameId for
// targeted message dispatch.

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
  const url = chrome.runtime.getURL('grid.html');
  const tab = await chrome.tabs.create({ url, active: false });
  gridTabId = tab.id;
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
  // Probe the iframe state via PROBE_STATE; consider it "ready" when input is
  // found AND the page settled (visibility=visible, no in-flight banners).
  // Fall back to a short sleep if probing keeps failing.
  const newFrameId = providerFrames.get(gridTabId)?.[provider];
  let ready = false;
  for (let i = 0; i < 24 && !ready; i++) { // up to 12s
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
    await swSleep(500);
  }
  if (!ready) await swSleep(1500);
}

// Gemini-specific: inject prompt by directly calling Quill's API in the
// iframe's main world. This bypasses the focus / execCommand requirement
// that fails for Quill in iframes. Retries because Quill may not be
// attached yet right after iframe reload + autoInit clicks.
async function injectGeminiPromptViaQuill(gridTabId, frameId, text) {
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 500;
  let lastErr = 'unknown';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await tryInjectQuillOnce(gridTabId, frameId, text);
    if (r?.ok) return r;
    lastErr = r?.error ?? 'no result';
    await swSleep(RETRY_DELAY_MS);
  }
  return { ok: false, error: `Quill not ready after ${MAX_ATTEMPTS} attempts: ${lastErr}` };
}

async function tryInjectQuillOnce(gridTabId, frameId, text) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: gridTabId, frameIds: [frameId] },
      world: 'MAIN',
      func: (txt) => {
        // Find Quill instance — try multiple known patterns
        const findQuill = () => {
          // 1. Global Quill.find()
          if (window.Quill && window.Quill.find) {
            const ed = document.querySelector('.ql-editor');
            if (ed) {
              const q = window.Quill.find(ed);
              if (q) return q;
            }
          }
          // 2. Walk up from .ql-editor checking for instance properties
          const editor = document.querySelector('.ql-editor');
          if (editor) {
            let node = editor;
            for (let i = 0; i < 6 && node; i++) {
              for (const key of ['__quill', '_quill', 'quill']) {
                if (node[key] && typeof node[key].insertText === 'function') {
                  return node[key];
                }
              }
              node = node.parentElement;
            }
          }
          // 3. Check rich-textarea web component
          const rt = document.querySelector('rich-textarea');
          if (rt) {
            for (const key of ['__quill', '_quill', 'quill', '_editor', 'editor']) {
              const obj = rt[key];
              if (obj && typeof obj.insertText === 'function') return obj;
              if (obj && obj._quill && typeof obj._quill.insertText === 'function') return obj._quill;
              if (obj && obj.__quill && typeof obj.__quill.insertText === 'function') return obj.__quill;
            }
          }
          return null;
        };

        const quill = findQuill();
        if (!quill) return { ok: false, error: 'no Quill instance found' };

        try {
          if (typeof quill.setText === 'function') {
            quill.setText(txt + '\n');
            return { ok: true, method: 'setText' };
          }
          if (typeof quill.insertText === 'function') {
            quill.insertText(0, txt);
            return { ok: true, method: 'insertText' };
          }
        } catch (err) {
          return { ok: false, error: err.message ?? String(err) };
        }
        return { ok: false, error: 'no setText/insertText method' };
      },
      args: [text]
    });
    return res?.result ?? { ok: false, error: 'no result from executeScript' };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// Poll a single iframe for stable text output (replacement for tab-based pollUntilStable)
async function pollFrameUntilStable(gridTabId, frameId, signal, onPartial) {
  // 5s instead of 3s. 3s gave false-positive "done" when a provider paused
  // mid-stream for tool-use, fetch, or just a slow chunk — we'd capture a
  // sentence-fragment as final R2 output and kick off Final on it.
  const STABLE_MS = 5000;
  const FALLBACK_STABLE_MS = 12000;
  const TIMEOUT_MS = 300000;
  const POLL_MS = 500;
  const FIRST_TEXT_TIMEOUT_MS = 90000;

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
        throw new Error('No assistant text appeared within 90s');
      }
    }

    await swSleep(POLL_MS);
  }
  throw new Error('Generation did not complete within 5 minutes');
}

// Dedicated window for AI tabs. User's main window stays focused except
// for the brief Phase 2 submit window where execCommand needs focus.
let aiWindowId = null;

(async () => {
  // Recover dedicated window id across SW restarts (session storage survives
  // SW termination but not browser restart, which is exactly what we want).
  try {
    const stored = await chrome.storage.session.get('aiWindowId');
    if (stored.aiWindowId) {
      try {
        await chrome.windows.get(stored.aiWindowId);
        aiWindowId = stored.aiWindowId;
      } catch (_) {
        await chrome.storage.session.remove('aiWindowId');
      }
    }
  } catch (_) {}
})();

// In-flight promise to deduplicate concurrent creation attempts.
// Without this, parallel Phase 1 callers each see aiWindowId===null and
// each create their own new window → 4 orphan about:blank windows.
let aiWindowCreationInFlight = null;

async function getOrCreateAIWindow() {
  if (aiWindowId) {
    try {
      await chrome.windows.get(aiWindowId);
      return aiWindowId;
    } catch (_) {
      aiWindowId = null;
    }
  }

  if (aiWindowCreationInFlight) {
    return aiWindowCreationInFlight;
  }

  aiWindowCreationInFlight = (async () => {
    try {
      const win = await chrome.windows.create({
        url: 'about:blank',
        focused: false,
        type: 'normal',
        width: 1000,
        height: 800,
        state: 'normal'
      });
      aiWindowId = win.id;
      try { await chrome.storage.session.set({ aiWindowId }); } catch (_) {}
      // Close the about:blank placeholder once real tabs have likely been
      // created. Keep around briefly in case window-with-zero-tabs would close.
      setTimeout(() => {
        if (aiWindowId === win.id && win.tabs?.[0]?.id) {
          chrome.tabs.remove(win.tabs[0].id).catch(() => {});
        }
      }, 8000);
      return aiWindowId;
    } finally {
      aiWindowCreationInFlight = null;
    }
  })();

  return aiWindowCreationInFlight;
}

chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === aiWindowId) {
    aiWindowId = null;
    ourTabs.clear();
    chrome.storage.session.remove('aiWindowId').catch(() => {});
  }
});

const MAX_ERRORS = 50;
const debugState = {
  errors: [],
  // keyed by `${stage}:${provider}`
  lastStages: {},
  lastResults: {}
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
    const expectedPrefix = chrome.runtime.getURL('grid.html');
    if (!tab?.url || !tab.url.startsWith(expectedPrefix)) return;
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
    knownTabs: {},
    errors: [...debugState.errors].reverse(),
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
    const tabId = ourTabs.get(provider) ?? null;
    out.knownTabs[provider] = tabId;

    let tabInfo = null;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabInfo = {
          url: tab.url,
          status: tab.status,
          active: tab.active,
          title: tab.title?.slice(0, 80) ?? null
        };
      } catch (err) {
        tabInfo = { error: err.message ?? String(err) };
      }
    }

    let probe = null;
    if (tabId) {
      try {
        probe = await chrome.tabs.sendMessage(tabId, { type: 'PROBE_STATE' });
      } catch (err) {
        probe = { error: err.message ?? String(err) };
      }
    }

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

    out.providerStates[provider] = { tabInfo, perStage, probe };
  }

  return out;
}

// =================== Tab management ===================

async function navigateTabAndWait(tabId, url, active) {
  const tab = await chrome.tabs.get(tabId);
  const sameUrl = tab.url === url;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timeout'));
    }, 30000);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    const fail = (err) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    };

    if (sameUrl) {
      if (active) chrome.tabs.update(tabId, { active: true }).catch(() => {});
      chrome.tabs.reload(tabId).catch(fail);
    } else {
      const updateProps = active ? { url, active: true } : { url };
      chrome.tabs.update(tabId, updateProps).catch(fail);
    }
  });
}

async function createTabAndWait(url, active) {
  const winId = await getOrCreateAIWindow();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab creation timeout'));
    }, 30000);
    let createdTabId = null;
    const listener = (id, info) => {
      if (id === createdTabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(createdTabId);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.create({ url, active, windowId: winId })
      .then(tab => {
        if (!tab.id) {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error('Tab creation failed: no id'));
          return;
        }
        createdTabId = tab.id;
      })
      .catch(err => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(err);
      });
  });
}

async function prepareProviderTab(provider, activate) {
  const config = PROVIDERS[provider];
  const knownTabId = ourTabs.get(provider);

  if (knownTabId) {
    try {
      const tab = await chrome.tabs.get(knownTabId);
      if (tab && config.matchUrls.some(p => tab.url?.startsWith(p))) {
        await navigateTabAndWait(knownTabId, config.startUrl, activate);
        return knownTabId;
      }
    } catch (_) {}
    ourTabs.delete(provider);
  }

  const tabId = await createTabAndWait(config.startUrl, activate);
  ourTabs.set(provider, tabId);
  return tabId;
}

async function pingContentScript(tabId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (r?.ok) return r;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('Content script did not respond');
}

// =================== Output polling ===================

async function pollUntilStable(tabId, provider, signal, onPartial) {
  const STABLE_MS = 3000;
  // Fallback must outlast both the keepalive per-tab gap AND any natural
  // model pause between sentences/paragraphs. 10s is conservative — slow
  // detection by ~3s but avoids truncating long Final outputs.
  const FALLBACK_STABLE_MS = 10000;
  const TIMEOUT_MS = 300000;
  const POLL_MS = 500;
  const FIRST_TEXT_TIMEOUT_MS = 90000;

  let lastText = '';
  let lastChangedAt = Date.now();
  const start = Date.now();
  let consecutiveProbeFails = 0;

  while (Date.now() - start < TIMEOUT_MS) {
    if (signal?.aborted) throw new Error('Pipeline cancelled');

    let state = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (typeof window.__multiAIPollState === 'function')
          ? window.__multiAIPollState()
          : null
      });
      state = res?.result ?? null;
      consecutiveProbeFails = 0;
    } catch (err) {
      consecutiveProbeFails++;
      if (consecutiveProbeFails >= 5) {
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
        throw new Error('No assistant text appeared within 90s');
      }
    }

    await sleep(POLL_MS);
  }
  throw new Error('Generation did not complete within 5 minutes');
}

// =================== Per-provider phases ===================

async function setupProvider(provider, stage) {
  postProvider(provider, stage, { status: 'running', stage: 'opening tab' });
  const tabId = await prepareProviderTab(provider, false);

  postProvider(provider, stage, { status: 'running', stage: 'connecting' });
  await pingContentScript(tabId);

  postProvider(provider, stage, { status: 'running', stage: 'preparing chat' });
  await chrome.tabs.sendMessage(tabId, { type: 'ENSURE_NEW_CHAT' });

  return tabId;
}

async function activateAndSubmit(tabId, provider, prompt, stage) {
  postProvider(provider, stage, { status: 'running', stage: 'submitting' });
  await chrome.tabs.update(tabId, { active: true });
  await sleep(600);

  let submitErr = null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, {
      type: 'SUBMIT_AND_WAIT_START',
      prompt
    });
    if (!r?.ok) submitErr = new Error(r?.error ?? 'submit failed');
  } catch (err) {
    submitErr = err;
  }

  if (submitErr) {
    const msg = String(submitErr.message ?? submitErr);
    const looksLikeUnload =
      msg.includes('message channel closed') ||
      msg.includes('Receiving end does not exist');

    if (looksLikeUnload) {
      try {
        await sleep(2000);
        await pingContentScript(tabId, 20);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.__multiAIPollState?.()?.messageCount ?? 0
        });
        const count = res?.result ?? 0;
        if (count > 0) {
          postProvider(provider, stage, { status: 'running', stage: 'generating' });
          return;
        }
      } catch (_) {}
    }
    throw submitErr;
  }

  postProvider(provider, stage, { status: 'running', stage: 'generating' });
}

async function waitForProviderOutput(tabId, provider, stage, startedAt, signal, onPartial) {
  const text = await pollUntilStable(tabId, provider, signal, onPartial);
  if (!text) throw new Error('Empty output');
  const elapsedMs = Date.now() - startedAt;
  postProvider(provider, stage, { status: 'done', output: text, elapsedMs });
  return { provider, ok: true, output: text, elapsedMs };
}

// =================== Single-provider path ===================

async function runSingle(provider, prompt, stage, signal, onPartial) {
  const startedAt = Date.now();
  postProvider(provider, stage, { status: 'running', stage: 'opening tab' });

  // Remember user window so we can return focus after the brief submit
  let userWindowId = null;
  try {
    const focused = await chrome.windows.getLastFocused({ populate: false });
    if (focused && focused.id !== aiWindowId) userWindowId = focused.id;
  } catch (_) {}

  try {
    const tabId = await prepareProviderTab(provider, false);
    postProvider(provider, stage, { status: 'running', stage: 'connecting' });
    await pingContentScript(tabId);

    postProvider(provider, stage, { status: 'running', stage: 'preparing chat' });
    await chrome.tabs.sendMessage(tabId, { type: 'ENSURE_NEW_CHAT' });

    if (signal?.aborted) throw new Error('Pipeline cancelled');

    // Focus AI window so tab isn't throttled-as-hidden during work
    if (aiWindowId) {
      try { await chrome.windows.update(aiWindowId, { focused: true }); } catch (_) {}
    }
    await activateAndSubmit(tabId, provider, prompt, stage);

    const text = await pollUntilStable(tabId, provider, signal, onPartial);
    if (!text) throw new Error('Empty output');

    const elapsedMs = Date.now() - startedAt;
    postProvider(provider, stage, { status: 'done', output: text, elapsedMs });
    return { provider, ok: true, output: text, elapsedMs };
  } catch (err) {
    const error = err?.message ?? String(err);
    postProvider(provider, stage, { status: 'failed', error });
    return { provider, ok: false, error };
  }
}

// =================== Parallel path ===================

async function runParallel(providers, prompts, stage, signal, onPartial) {
  // Remember the user's currently-focused window so we can return focus to it
  // after the brief Phase 2 submit window. Phase 3 keepalive cycles tabs in
  // the AI window without ever stealing focus from this one.
  let userWindowId = null;
  try {
    const focused = await chrome.windows.getLastFocused({ populate: false });
    if (focused && focused.id !== aiWindowId) userWindowId = focused.id;
  } catch (_) {}

  const startedAt = Date.now();
  const tabIds = {};
  const failed = new Set();

  // Phase 1: open + connect + ensure-new-chat (parallel, background)
  await Promise.all(providers.map(async (p) => {
    try {
      tabIds[p] = await setupProvider(p, stage);
    } catch (err) {
      failed.add(p);
      postProvider(p, stage, { status: 'failed', error: err.message ?? String(err) });
    }
  }));

  // Focus AI window for the entire stage. Chromium throttles tabs in
  // unfocused windows as if they were hidden — render schedulers, framework
  // re-renders, SSE→DOM all stall — which is why DS R2 submitting got
  // stuck previously. Tabs need their window focused to operate normally.
  if (aiWindowId) {
    try { await chrome.windows.update(aiWindowId, { focused: true }); } catch (_) {}
  }

  // Phase 2: serial submit
  for (const p of providers) {
    if (failed.has(p)) continue;
    if (signal?.aborted) {
      failed.add(p);
      continue;
    }
    try {
      await activateAndSubmit(tabIds[p], p, prompts[p], stage);
    } catch (err) {
      failed.add(p);
      postProvider(p, stage, { status: 'failed', error: err.message ?? String(err) });
    }
  }

  if (signal?.aborted) throw new Error('Pipeline cancelled');

  // Phase 3: parallel wait + rotating keepalive. Tabs cycle within the AI
  // window (no focus stealing) but stay "visible in their window" so the
  // framework re-renders aren't throttled.
  const pending = new Set(providers.filter(p => !failed.has(p)));
  const keepalive = startKeepalive(pending, tabIds);

  const results = await Promise.all(providers.map(async (p) => {
    if (failed.has(p)) {
      return { provider: p, ok: false, error: 'failed in earlier phase' };
    }
    try {
      return await waitForProviderOutput(
        tabIds[p], p, stage, startedAt, signal,
        onPartial ? (partial) => onPartial(p, partial) : null
      );
    } catch (err) {
      const error = err?.message ?? String(err);
      postProvider(p, stage, { status: 'failed', error });
      return { provider: p, ok: false, error };
    } finally {
      pending.delete(p);
    }
  }));

  clearInterval(keepalive);
  return results;
}

// Rotate through pending tabs, each becoming active for the full cycle
// duration. No flashing back to the user's tab — that'd just thrash. The
// caller restores the user's tab once phase 3 completes.
function startKeepalive(pendingSet, tabIds) {
  let cycleIdx = 0;

  const cycle = async () => {
    const pendingList = [...pendingSet];
    if (pendingList.length === 0) return;
    const provider = pendingList[cycleIdx % pendingList.length];
    cycleIdx++;
    const tabId = tabIds[provider];
    if (!tabId) return;
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (_) {}
  };

  cycle(); // first rotation immediately, don't wait the interval
  return setInterval(cycle, 2000);
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

  // ----- Phase 2: serial submit (focus + inject + click + wait first token) -----
  for (const provider of providers) {
    if (failed.has(provider)) continue;
    if (signal?.aborted) {
      failed.add(provider);
      continue;
    }

    try {
      const frameId = getFrameId(gridTabId, provider);
      if (frameId == null) throw new Error(`No frameId for ${provider}`);

      postProvider(provider, stage, { status: 'running', stage: 'submitting' });

      // Focus this iframe — exclusive focus since we serialized
      try {
        await chrome.runtime.sendMessage({ type: 'FOCUS_IFRAME', provider });
      } catch (_) {}
      // Give the focus chain a real moment to settle. iframe.focus() is
      // async-ish under the hood and 200ms isn't enough on slower machines.
      await swSleep(600);

      // Verify focus actually took (programmatic focus without user gesture
      // may be a no-op). If not focused, retry with mouse-click simulation.
      try {
        const [check] = await chrome.scripting.executeScript({
          target: { tabId: gridTabId, frameIds: [frameId] },
          func: () => ({ hasFocus: document.hasFocus(), vis: document.visibilityState })
        });
        if (!check?.result?.hasFocus) {
          // Try a more aggressive focus attempt via mouse-event simulation in grid
          try {
            await chrome.runtime.sendMessage({ type: 'FOCUS_IFRAME_AGGRESSIVE', provider });
          } catch (_) {}
          await swSleep(400);
        }
      } catch (_) {}

      // Gemini Quill API hijack (focus-independent, retried internally)
      let skipInput = false;
      if (provider === 'gemini') {
        const r = await injectGeminiPromptViaQuill(gridTabId, frameId, prompts[provider]);
        if (r?.ok) skipInput = true;
      }

      const submitResp = await chrome.tabs.sendMessage(
        gridTabId,
        { type: 'SUBMIT_AND_WAIT_START', prompt: prompts[provider], skipInput },
        { frameId }
      );
      if (!submitResp?.ok) throw new Error(submitResp?.error ?? 'submit failed');

      postProvider(provider, stage, { status: 'running', stage: 'generating' });
    } catch (err) {
      failed.add(provider);
      postProvider(provider, stage, { status: 'failed', error: err?.message ?? String(err) });
    }
  }

  if (signal?.aborted) throw new Error('Pipeline cancelled');

  // ----- Phase 3: parallel poll for stable text -----
  return await Promise.all(providers.map(async (provider) => {
    if (failed.has(provider)) {
      return { provider, ok: false, error: 'failed in earlier phase' };
    }
    try {
      const frameId = getFrameId(gridTabId, provider);
      const onPartialThis = onPartial ? (p) => onPartial(provider, p) : null;
      const text = await pollFrameUntilStable(gridTabId, frameId, signal, onPartialThis);
      if (!text) throw new Error('Empty output');

      const elapsedMs = Date.now() - (startTimes[provider] ?? startedAt);
      postProvider(provider, stage, { status: 'done', output: text, elapsedMs });
      return { provider, ok: true, output: text, elapsedMs };
    } catch (err) {
      const error = err?.message ?? String(err);
      postProvider(provider, stage, { status: 'failed', error });
      return { provider, ok: false, error };
    }
  }));
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

async function closeAllProviderTabs() {
  const ids = [...ourTabs.values()];
  ourTabs.clear();
  for (const id of ids) {
    chrome.tabs.remove(id).catch(() => {});
  }
}

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
      // Capture user's current window so we can return focus when done
      let userWindowId = null;
      try {
        const focused = await chrome.windows.getLastFocused();
        if (focused && focused.id !== aiWindowId) userWindowId = focused.id;
      } catch (_) {}

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
        // Hand focus back to the user's main window
        if (userWindowId) {
          chrome.windows.update(userWindowId, { focused: true }).catch(() => {});
        }
        closeAllProviderTabs();
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
    getOrCreateGridTab()
      .then(tabId => chrome.tabs.update(tabId, { active: true }))
      .then(() => sendResponse({ ok: true, gridTabId }))
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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [provider, id] of ourTabs.entries()) {
    if (id === tabId) ourTabs.delete(provider);
  }
});
