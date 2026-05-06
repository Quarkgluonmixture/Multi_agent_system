// External script for grid.html — inline scripts are blocked by MV3
// extension page CSP (script-src 'self'), so all interactivity lives here.

function reloadIframe(id) {
  const f = document.getElementById(id);
  if (f) f.src = f.src;
}

document.querySelectorAll('button.action[data-target]').forEach(btn => {
  btn.addEventListener('click', () => reloadIframe(btn.dataset.target));
});

const reloadAllBtn = document.getElementById('reload-all');
if (reloadAllBtn) {
  reloadAllBtn.addEventListener('click', () => {
    ['cg', 'g', 'ds', 'km'].forEach(reloadIframe);
  });
}

// SW asks us (the parent document) to perform iframe-level operations that
// can't be done from a content script in the iframe (cross-origin) and
// can't be done from SW directly (chrome.scripting.executeScript can't
// touch chrome-extension:// pages).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'RELOAD_IFRAME' && msg.provider) {
    const iframe = document.querySelector(`iframe[data-provider="${msg.provider}"]`);
    if (iframe) {
      iframe.src = iframe.src;
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'iframe not found' });
    }
    return false;
  }
  if (msg?.type === 'FOCUS_IFRAME' && msg.provider) {
    const iframe = document.querySelector(`iframe[data-provider="${msg.provider}"]`);
    if (iframe) {
      try { window.focus(); } catch (_) {}
      iframe.focus();
      if (iframe.contentWindow) {
        try { iframe.contentWindow.focus(); } catch (_) {}
      }
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'iframe not found' });
    }
    return false;
  }
  if (msg?.type === 'FOCUS_IFRAME_AGGRESSIVE' && msg.provider) {
    // Last-resort focus attempt — simulate a mouse click on the iframe
    // element. Browsers sometimes treat this as more "user-like" than a bare
    // .focus() call and grant the iframe document focus.
    const iframe = document.querySelector(`iframe[data-provider="${msg.provider}"]`);
    if (iframe) {
      const rect = iframe.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0
      };
      try { iframe.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
      try { iframe.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
      try { iframe.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
      iframe.focus();
      if (iframe.contentWindow) {
        try { iframe.contentWindow.focus(); } catch (_) {}
      }
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'iframe not found' });
    }
    return false;
  }
});
