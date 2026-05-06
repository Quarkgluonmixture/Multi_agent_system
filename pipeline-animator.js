// Pipeline animation — 3-stage visual: R1 (各自陈述) → R2 (群儒论战) → Final (主编呈奏).
// API: window.PipelineAnimator.start(providers, finalEditor), update(stage, provider, status), end()
window.PipelineAnimator = (function () {
  const PROVIDERS_INFO = {
    chatgpt:  { color: '#10a37f', role: '杠精',   icon: 'icons/chatgpt.jpeg' },
    gemini:   { color: '#4285f4', role: '串子',   icon: 'icons/gemini.jpeg' },
    deepseek: { color: '#4f46e5', role: '懂王',   icon: 'icons/deepseek.jpeg' },
    kimi:     { color: '#9333ea', role: '打工人', icon: 'icons/kimi.jpeg' }
  };

  // Percentage coordinates: 4 corners (R1) → cluster center (R2)
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
      activeProviders = providers || Object.keys(PROVIDERS_INFO);
      currentStage = 'r1';
      container.className = 'active stage-r1';
      container.style.display = 'block';

      let linesHTML = '<svg id="pa-lines-layer" class="pa-layer">';
      for (let i = 0; i < activeProviders.length; i++) {
        for (let j = i + 1; j < activeProviders.length; j++) {
          linesHTML += `<line class="pa-line" x1="${POSITIONS.r2[i].x}" y1="${POSITIONS.r2[i].y}" x2="${POSITIONS.r2[j].x}" y2="${POSITIONS.r2[j].y}"></line>`;
        }
      }
      linesHTML += '</svg>';

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
          </div>
        `;
      });
      avatarsHTML += '</div>';

      const scrollHTML = `
        <div id="pa-scroll-layer" class="pa-layer">
          <div id="pa-scroll-box">
            <div class="pa-skeleton" style="width: 80%"></div>
            <div class="pa-skeleton" style="width: 100%"></div>
            <div class="pa-skeleton" style="width: 60%"></div>
          </div>
        </div>
      `;

      container.innerHTML = linesHTML + scrollHTML + avatarsHTML;
      requestAnimationFrame(() => { container.style.opacity = '1'; });
    },

    update(stage, provider, status) {
      if (!container) return;
      if (stage !== currentStage) {
        currentStage = stage;
        container.className = `active stage-${stage}`;
        // Resetting per-stage statuses so animations restart
        document.querySelectorAll('.pa-avatar-wrapper').forEach(el => {
          el.dataset.status = 'running';
        });
      }
      const node = document.getElementById(`pa-avatar-${provider}`);
      if (node) node.dataset.status = status;
    },

    end() {
      if (!container) return;
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
