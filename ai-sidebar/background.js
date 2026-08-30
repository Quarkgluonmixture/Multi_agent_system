chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[ai-sidebar] setPanelBehavior failed', err));
