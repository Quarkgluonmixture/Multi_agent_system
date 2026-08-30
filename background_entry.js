import './background.js';

// Generic one-shot WhatsApp outbound primitive.
// Keeps the existing relay/pipeline untouched and exposes a narrow runtime
// message for extension-owned pages: { type:'WHATSAPP_SEND_ONCE', phone, text, keepTab? }.

let whatsappOneShotBusy = false;

function normalizeWhatsAppPhone(raw) {
  const compact = String(raw ?? '').trim().replace(/[^\d+]/g, '');
  const digits = compact.startsWith('+') ? compact.slice(1) : compact;
  if (!/^\d{7,15}$/.test(digits)) {
    throw new Error('WhatsApp phone must be 7-15 digits (E.164 recommended, e.g. +447700900123)');
  }
  return digits;
}

function normalizeWhatsAppText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Message text is empty');
  if (text.length > 20000) throw new Error('Message text exceeds 20,000 characters');
  return text;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('WhatsApp tab did not finish loading');
}

async function sendWhatsAppOnce(phone, text, { keepTab = false } = {}) {
  const digits = normalizeWhatsAppPhone(phone);
  const body = normalizeWhatsAppText(text);
  const url = `https://web.whatsapp.com/send?phone=${digits}`;

  const win = await chrome.windows.create({
    url,
    type: 'normal',
    focused: false,
    width: 1280,
    height: 900
  });
  const windowId = win.id;
  const tabId = win.tabs?.[0]?.id;
  if (tabId == null) throw new Error('Failed to create WhatsApp tab');

  let success = false;
  try {
    await waitForTabComplete(tabId, 30000);

    // WhatsApp Web boots client-side after tab.status becomes complete.
    // Keep probing the already-declared whatsapp_inject.js content script.
    const deadline = Date.now() + 90000;
    let lastError = 'whatsapp content script never responded';
    while (Date.now() < deadline) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'WHATSAPP_SEND',
          text: body
        });
        if (response?.ok) {
          success = true;
          return { ok: true, phone: `+${digits}`, tabId };
        }
        if (response && response.ok === false) {
          lastError = response.error || 'unknown WhatsApp send failure';
          break;
        }
      } catch (err) {
        lastError = err?.message ?? String(err);
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return { ok: false, error: lastError, phone: `+${digits}`, tabId };
  } finally {
    // Successful one-shot sends should not leave disposable windows behind.
    // Failures stay open so the user can inspect login / selector / invalid-number UI.
    if (success && !keepTab && windowId != null) {
      setTimeout(() => chrome.windows.remove(windowId).catch(() => {}), 1200);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'WHATSAPP_SEND_ONCE') return;

  // Internal primitive only: reject messages that do not originate from this extension.
  const ownOrigin = chrome.runtime.getURL('');
  if (sender?.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(ownOrigin))) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

  if (whatsappOneShotBusy) {
    sendResponse({ ok: false, error: 'another one-shot WhatsApp send is already running' });
    return false;
  }

  whatsappOneShotBusy = true;
  sendWhatsAppOnce(msg.phone, msg.text, { keepTab: !!msg.keepTab })
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: err?.message ?? String(err) }))
    .finally(() => { whatsappOneShotBusy = false; });
  return true;
});
