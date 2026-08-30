const PROVIDERS = ['gpt', 'gemini'];
const STORAGE_KEY = 'ai_sidebar_active_provider';

const tabs = Object.fromEntries(PROVIDERS.map(p => [p, document.getElementById(`tab-${p}`)]));
const frames = Object.fromEntries(PROVIDERS.map(p => [p, document.getElementById(`frame-${p}`)]));

const loaded = new Set();

function activate(provider) {
  if (!PROVIDERS.includes(provider)) provider = 'gpt';

  if (!loaded.has(provider)) {
    const f = frames[provider];
    f.src = f.dataset.src;
    loaded.add(provider);
  }

  for (const p of PROVIDERS) {
    tabs[p].classList.toggle('active', p === provider);
    frames[p].classList.toggle('active', p === provider);
  }

  chrome.storage?.local.set({ [STORAGE_KEY]: provider });
}

for (const p of PROVIDERS) {
  tabs[p].addEventListener('click', () => activate(p));
}

document.getElementById('reload-btn').addEventListener('click', () => {
  const active = PROVIDERS.find(p => tabs[p].classList.contains('active')) || 'gpt';
  const f = frames[active];
  f.src = f.dataset.src;
});

(async () => {
  let initial = 'gpt';
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    if (r && PROVIDERS.includes(r[STORAGE_KEY])) initial = r[STORAGE_KEY];
  } catch (_) {}
  activate(initial);
})();
