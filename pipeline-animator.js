// Pipeline animation — 3-stage visual:
//   R1 各自陈述: 水波纹涟漪 + 打字三点动画
//   R2 群儒论战: 中心风暴眼 + 高频抖动 + 子弹流连线 + 完成后退场变灰
//   Final 主编呈奏: 主编居中放大 + 奏折展开 shimmer
// API: window.PipelineAnimator.start(providers, finalEditor),
//      .update(stage, provider, status), .end()
window.PipelineAnimator = (function () {
  const PROVIDERS_INFO = {
    chatgpt:  { color: '#10a37f', role: '杠精',   icon: 'icons/chatgpt.jpeg' },
    gemini:   { color: '#4285f4', role: '串子',   icon: 'icons/gemini.jpeg' },
    deepseek: { color: '#4f46e5', role: '懂王',   icon: 'icons/deepseek.jpeg' },
    kimi:     { color: '#9333ea', role: '打工人', icon: 'icons/kimi.jpeg' }
  };

  const POSITIONS = {
    r1: [
      { x: '20%', y: '25%' }, { x: '80%', y: '25%' },
      { x: '20%', y: '75%' }, { x: '80%', y: '75%' }
    ],
    r2: [
      { x: '35%', y: '35%' }, { x: '65%', y: '35%' },
      { x: '35%', y: '65%' }, { x: '65%', y: '65%' }
    ]
  };

  let container = null;
  let currentStage = null;
  let activeProviders = [];
  // Stage-transition delay: hold the CSS class change so the just-completed
  // avatar's done animation plays out fully. R1 → R2 holds longer because
  // R1's done state has the more elaborate two-layer burst+pulse that needs
  // time to read. R2 → Final is shorter — R2 done is a quick burst+gray.
  let pendingUpdates = [];
  let stageTransitionTimer = null;
  let lastDoneTime = 0;
  const STAGE_HOLD_FROM_R1_MS = 2400;
  const STAGE_HOLD_FROM_R2_MS = 1400;

  function getIconSVG() {
    return '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function init() {
    if (!container) container = document.getElementById('pipeline-animator');
    return !!container;
  }

  return {
    start(providers, finalEditor) {
      if (!init()) return;
      // Clean any prior run's pending state
      if (stageTransitionTimer != null) {
        clearTimeout(stageTransitionTimer);
        stageTransitionTimer = null;
      }
      pendingUpdates = [];
      lastDoneTime = 0;
      activeProviders = providers || Object.keys(PROVIDERS_INFO);
      currentStage = 'r1';
      container.className = 'active stage-r1';
      container.style.display = 'block';

      // R2 connecting lines (bullet stream)
      let linesHTML = '<svg id="pa-lines-layer" class="pa-layer">';
      for (let i = 0; i < activeProviders.length; i++) {
        for (let j = i + 1; j < activeProviders.length; j++) {
          linesHTML += `<line class="pa-line" x1="${POSITIONS.r2[i].x}" y1="${POSITIONS.r2[i].y}" x2="${POSITIONS.r2[j].x}" y2="${POSITIONS.r2[j].y}"></line>`;
        }
      }
      linesHTML += '</svg>';

      // R2 storm eye (radial gradient hub)
      const hubHTML = '<div id="pa-hub-layer" class="pa-layer"><div id="pa-clash-hub"></div></div>';

      // Avatar nodes (with ripple ring + typing dots)
      let avatarsHTML = '<div id="pa-avatars-layer" class="pa-layer">';
      activeProviders.forEach((prov, idx) => {
        const info = PROVIDERS_INFO[prov];
        if (!info) return;
        const isFinal = (prov === finalEditor) ? 'is-final' : '';
        const posIdx = Math.min(idx, 3);
        avatarsHTML += `
          <div class="pa-avatar-wrapper ${isFinal}" id="pa-avatar-${prov}" data-status="running"
               style="--base-color: ${info.color}; --x-r1: ${POSITIONS.r1[posIdx].x}; --y-r1: ${POSITIONS.r1[posIdx].y}; --x-r2: ${POSITIONS.r2[posIdx].x}; --y-r2: ${POSITIONS.r2[posIdx].y};">
            <div class="pa-avatar-ring"></div>
            <div class="pa-avatar-core">
              <img class="pa-avatar-img" src="${info.icon}" alt="${prov}">
              <div class="pa-status-icon">${getIconSVG()}</div>
            </div>
            <div class="pa-role">${info.role}</div>
            <div class="pa-typing-dots"><span></span><span></span><span></span></div>
          </div>
        `;
      });
      avatarsHTML += '</div>';

      // Final stage scroll (奏折)
      const scrollHTML = `
        <div id="pa-scroll-layer" class="pa-layer">
          <div id="pa-scroll-box">
            <div class="pa-skeleton" style="width: 80%"></div>
            <div class="pa-skeleton" style="width: 100%"></div>
            <div class="pa-skeleton" style="width: 60%"></div>
          </div>
        </div>
      `;

      container.innerHTML = linesHTML + hubHTML + scrollHTML + avatarsHTML;
      requestAnimationFrame(() => { container.style.opacity = '1'; });
    },

    update(stage, provider, status) {
      if (!container) return;
      if (status === 'done') lastDoneTime = Date.now();

      const applyStatus = (s, p, st) => {
        const n = document.getElementById(`pa-avatar-${p}`);
        if (n) n.dataset.status = st;
      };

      if (stage !== currentStage) {
        // Stage change requested — queue + delay so the previous stage's
        // done animations finish before the CSS class flips.
        pendingUpdates.push({ stage, provider, status });
        if (stageTransitionTimer != null) return;
        const sinceLastDone = Date.now() - lastDoneTime;
        const hold = currentStage === 'r1' ? STAGE_HOLD_FROM_R1_MS : STAGE_HOLD_FROM_R2_MS;
        const delay = Math.max(0, hold - sinceLastDone);
        stageTransitionTimer = setTimeout(() => {
          stageTransitionTimer = null;
          // Use the latest queued update's stage as target
          const target = pendingUpdates[pendingUpdates.length - 1].stage;
          currentStage = target;
          container.className = `active stage-${target}`;
          // Reset all to running for new stage (except Final preserves R2-done grey)
          if (target !== 'final') {
            document.querySelectorAll('.pa-avatar-wrapper').forEach(el => {
              el.dataset.status = 'running';
            });
          }
          // Flush queued status updates
          for (const u of pendingUpdates) applyStatus(u.stage, u.provider, u.status);
          pendingUpdates = [];
        }, delay);
        return;
      }

      // During a pending transition, queue (avoid stale class)
      if (stageTransitionTimer != null) {
        pendingUpdates.push({ stage, provider, status });
        return;
      }

      // Same stage, no transition in flight — apply immediately
      applyStatus(stage, provider, status);
    },

    end() {
      if (!container) return;
      // Cancel any queued stage transition
      if (stageTransitionTimer != null) {
        clearTimeout(stageTransitionTimer);
        stageTransitionTimer = null;
      }
      pendingUpdates = [];
      lastDoneTime = 0;
      container.style.opacity = '0';
      setTimeout(() => {
        container.style.display = 'none';
        container.innerHTML = '';
        container.className = '';
        currentStage = null;
      }, 400);
    }
  };
})();
