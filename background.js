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

const MAX_ERRORS = 50;
const debugState = {
  errors: [],
  // keyed by `${stage}:${provider}`
  lastStages: {},
  lastResults: {}
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pushError(provider, stage, message) {
  debugState.errors.push({
    ts: new Date().toISOString(),
    provider,
    stage,
    message: String(message ?? '')
  });
  if (debugState.errors.length > MAX_ERRORS) debugState.errors.shift();
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
  }
  if (payload.status === 'failed' && payload.error) {
    pushError(provider, `${stage}/${debugState.lastStages[key] ?? '?'}`, payload.error);
  }
  chrome.runtime
    .sendMessage({ type: 'PROVIDER_UPDATE', provider, round: stage, ...payload })
    .catch(() => {});
}

async function collectDebug() {
  const out = {
    timestamp: new Date().toISOString(),
    extension: chrome.runtime.getManifest()?.version ?? '?',
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '?',
    knownTabs: {},
    errors: [...debugState.errors].reverse(),
    providerStates: {}
  };

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

function createTabAndWait(url, active) {
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
    chrome.tabs.create({ url, active })
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

  try {
    const tabId = await prepareProviderTab(provider, true);
    postProvider(provider, stage, { status: 'running', stage: 'connecting' });
    await pingContentScript(tabId);

    postProvider(provider, stage, { status: 'running', stage: 'preparing chat' });
    await chrome.tabs.sendMessage(tabId, { type: 'ENSURE_NEW_CHAT' });

    if (signal?.aborted) throw new Error('Pipeline cancelled');

    // Two-phase submit + SW polling, same path as parallel — so single mode
    // can stream partials too.
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
  let originalTabId = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    originalTabId = activeTab?.id ?? null;
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

  // Phase 2: serial submit (each tab activated briefly for execCommand to work)
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

  if (signal?.aborted) {
    if (originalTabId) chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
    throw new Error('Pipeline cancelled');
  }

  // Don't restore the user's tab between phase 2 and phase 3 — phase 3
  // rotation would immediately steal it again, causing an extra unwanted blip.
  // We restore once after phase 3 fully completes.

  // Phase 3: parallel wait + rotating keepalive
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
  if (originalTabId) {
    chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
  }

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

  // Stream partial outputs to UI only for the Final stage. R1/R2 are parallel
  // (3 providers) so streaming text into a single bubble doesn't make sense,
  // and they go into the collapsed details section anyway.
  const onPartial = stage === 'final'
    ? (provider, partial) => postProvider(provider, stage, {
        status: 'running', stage: 'generating', partialOutput: partial
      })
    : null;

  if (providers.length === 1) {
    const onPartialSingle = onPartial
      ? (partial) => onPartial(providers[0], partial)
      : null;
    return [await runSingle(providers[0], prompts[providers[0]], stage, signal, onPartialSingle)];
  }
  return await runParallel(providers, prompts, stage, signal, onPartial);
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

function buildR2Prompt(userPrompt, selfProvider, r1Outputs, history = []) {
  const others = ALL_PROVIDERS
    .filter(p => p !== selfProvider && r1Outputs[p])
    .map(p => `<other_answer provider="${p}">\n${r1Outputs[p]}\n</other_answer>`)
    .join('\n\n');

  const selfAnswer = r1Outputs[selfProvider] ?? '(missing)';

  return `你是交叉评审 agent。你将看到自己的第一轮回答，以及其他模型的第一轮回答。任务不是辩护自己，而是诚实地评估、吸收、反驳。

${historyBlock(history)}本轮用户问题：
${userPrompt}

你的第一轮回答：
<self_answer>
${selfAnswer}
</self_answer>

其他模型回答：
${others}

请严格按以下格式输出：

<revision>
共识：
（三家都同意的核心点）

我吸收的观点：
1. 来自 [模型名]：（具体哪一句让你改了想法）
2. ...

我不同意的观点：
1. （指出哪个模型的哪一点你认为错了，给理由）
2. ...

修正后的完整回答：
（不是 diff，是完整的新版本——融合了你接受的他人观点 + 你坚持的原观点）

仍然存在的分歧：
（你判断哪些点这一轮没法和解，留给最终主编裁决）
</revision>`;
}

function buildFinalPrompt(userPrompt, r2Outputs, history = []) {
  const sections = ALL_PROVIDERS
    .filter(p => r2Outputs[p])
    .map(p => `<revised_answer provider="${p}">\n${r2Outputs[p]}\n</revised_answer>`)
    .join('\n\n');

  return `你是最终主编。你的任务不是平均三份答案，而是判断、去重、合并、裁剪、解决矛盾。把读者当成只读你这一份输出的人——他们看不到上面三份原文，也看不到 R1/R2 的内部结构。

${historyBlock(history)}本轮用户问题：
${userPrompt}

三份第二轮回答如下：

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

async function runFullPipeline(userPrompt, history = [], enabledProviders, finalEditorOverride, signal) {
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

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('Pipeline cancelled');
  };

  // Round 1
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

  // Round 2
  checkAbort();
  const r2Prompts = {};
  for (const p of r1Survivors) {
    r2Prompts[p] = buildR2Prompt(userPrompt, p, r1Outputs, history);
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

  // Final
  checkAbort();
  const finalPrompt = buildFinalPrompt(userPrompt, r2Outputs, history);
  const finalResults = await runStage({
    providers: [finalEditor], prompts: { [finalEditor]: finalPrompt }, stage: 'final', signal
  });

  return {
    r1: r1Results,
    r2: r2Results,
    final: finalResults[0]
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

    runFullPipeline(msg.prompt, msg.history ?? [], msg.providers, msg.finalEditor, signal)
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(err => {
        const cancelled = signal.aborted || err.message === 'Pipeline cancelled';
        sendResponse({ ok: false, error: err.message ?? String(err), cancelled });
      })
      .finally(() => {
        if (activePipelineAbort?.signal === signal) activePipelineAbort = null;
        closeAllProviderTabs();
      });
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
