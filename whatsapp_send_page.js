const phoneEl = document.getElementById('wa-phone');
const textEl = document.getElementById('wa-text');
const keepTabEl = document.getElementById('wa-keep-tab');
const sendBtn = document.getElementById('wa-send');
const statusEl = document.getElementById('wa-status');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  const phone = params.get('phone');
  const text = params.get('text');
  if (phone) phoneEl.value = phone;
  if (text) textEl.value = text;
}

sendBtn.addEventListener('click', async () => {
  const phone = phoneEl.value.trim();
  const text = textEl.value.trim();
  if (!phone || !text) {
    setStatus('请填写号码和消息正文。', 'error');
    return;
  }

  sendBtn.disabled = true;
  setStatus('正在打开 WhatsApp Web 并发送…', 'busy');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'WHATSAPP_SEND_ONCE',
      phone,
      text,
      keepTab: keepTabEl.checked
    });
    if (r?.ok) {
      setStatus(`✓ 已发送到 ${r.phone}`, 'ok');
    } else {
      setStatus(`发送失败：${r?.error ?? 'unknown error'}。失败页面会保留用于检查。`, 'error');
    }
  } catch (err) {
    setStatus(`发送失败：${err?.message ?? err}`, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

textEl.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    sendBtn.click();
  }
});

prefillFromQuery();
