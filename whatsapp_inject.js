// Content script for web.whatsapp.com.
// Listens for WHATSAPP_SEND { text } from the SW, waits for the message
// input on the currently-open chat, pastes the text, and clicks Send.
//
// Flow assumed: SW opened https://web.whatsapp.com/send?phone=XXX in this
// tab; once the chat input appears, we drop the text in and send.
(() => {
  if (window.__waRelayInstalled) return;
  window.__waRelayInstalled = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = predicate();
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }

  function findMessageInput() {
    // WhatsApp Web rev keeps changing — try several selectors, pick the one
    // sitting in the chat footer (not the search box at top).
    const candidates = [
      'footer div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][aria-placeholder*="message" i]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer [contenteditable="true"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findSendButton() {
    // Most reliable: the send icon span, then walk up to whatever element
    // is acting as the click target (sometimes <button>, sometimes
    // <div role="button">, depends on WA Web revision).
    const iconSelectors = [
      'span[data-icon="send"]',
      'span[data-icon="wds-ic-send-filled"]',
      'span[data-icon="send-light"]'
    ];
    for (const sel of iconSelectors) {
      const icon = document.querySelector(sel);
      if (icon) {
        const clickable = icon.closest('button, [role="button"], [aria-label]');
        if (clickable) return clickable;
      }
    }
    return (
      document.querySelector('button[aria-label="Send"]') ||
      document.querySelector('button[aria-label="发送"]') ||
      document.querySelector('button[aria-label*="Send" i]') ||
      document.querySelector('div[role="button"][aria-label*="Send" i]') ||
      document.querySelector('button[data-tab="11"]') ||
      null
    );
  }

  // Detect the "phone number not on WhatsApp" / invalid phone modal so we
  // can surface a useful error instead of timing out on the input.
  function findInvalidPhoneDialog() {
    const txt = document.body.innerText || '';
    if (/phone number shared via url is invalid/i.test(txt)) return 'invalid_phone';
    if (/isn'?t on whatsapp/i.test(txt)) return 'not_on_whatsapp';
    return null;
  }

  function insertText(input, text) {
    // Two-pronged insertion: WA's Lexical editor reformats text into block
    // children on insertion, so a naive innerText.includes() readback often
    // returns false even though the paste succeeded. Don't gate on that —
    // try both strategies and let the send-button visibility tell us
    // whether something landed.
    input.focus();
    try { document.execCommand('insertText', false, text); } catch (_) {}
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
    } catch (_) {}
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function inputHasContent(el) {
    if (!el) return false;
    return ((el.innerText || el.textContent || '').trim().length > 0);
  }

  async function sendMessage(text) {
    // Surface obvious "can't send" states up-front instead of waiting 60s
    // for an input box that'll never appear.
    await sleep(800);
    const dialog = findInvalidPhoneDialog();
    if (dialog) return { ok: false, error: dialog };

    const input = await waitFor(findMessageInput, { timeoutMs: 60000, intervalMs: 400 });
    if (!input) {
      const d2 = findInvalidPhoneDialog();
      return { ok: false, error: d2 ?? 'input_not_found' };
    }

    insertText(input, text);
    await sleep(600);

    // Wait for the send button to materialize (WA only shows it once the
    // composer is non-empty). Up to 12s for slow loads / Lexical settle.
    const sendBtn = await waitFor(() => {
      const b = findSendButton();
      if (!b) return null;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
      return b;
    }, { timeoutMs: 12000, intervalMs: 250 });

    if (sendBtn) {
      sendBtn.click();
    } else {
      // Last-ditch: synthesize Enter. WA's Lexical usually swallows this,
      // but worth one shot before reporting failure.
      pressEnter(input);
    }

    // Confirm send: WA clears the composer after a successful send. Allow
    // a few seconds for the network round-trip.
    const cleared = await waitFor(
      () => inputHasContent(input) ? null : true,
      { timeoutMs: 6000, intervalMs: 300 }
    );
    if (cleared) return { ok: true };

    // Composer still has text. If we never found a send button, surface
    // that distinct error so the user knows to check their WA Web layout.
    return {
      ok: false,
      error: sendBtn ? 'send_clicked_but_input_not_cleared' : 'send_button_not_found'
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'WHATSAPP_SEND') return;
    sendMessage(String(msg.text ?? ''))
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }));
    return true; // async sendResponse
  });
})();
