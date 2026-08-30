// Telegram long-poller for the iPhone → PC relay.
//
// Imported by background.js (which is an ES module). Exposes a TelegramRelay
// class that:
//   - long-polls getUpdates and filters messages by allowed_user_id
//   - groups photos by media_group_id with a short debounce (so a multi-image
//     album comes in as ONE batch instead of N separate triggers)
//   - downloads photos via getFile and hands base64 strings to onBatch
//
// SW death survival: offset is persisted to chrome.storage on every successful
// update so we don't re-process the same messages after a service-worker
// restart. The orchestrator in background.js drives start() from a
// chrome.alarms tick, so dying mid-poll is recoverable.

const STORE_OFFSET_KEY = 'tgRelay.offset';
// Coalesce-window for photos arriving as separate channel posts. iPhone
// Shortcut uploads N photos sequentially via N sendPhoto calls, so each
// arrives as its own update. We wait this long after the LAST photo before
// finalising the batch — bigger window = more tolerance for slow networks
// but more startup latency. 6s comfortably covers ~10 photos on LTE.
const BATCH_DEBOUNCE_MS = 6000;
const LONG_POLL_TIMEOUT_S = 25;

export class TelegramRelay {
  constructor({ token, allowedUserId, allowedChannelId, onBatch, onLog }) {
    this.token = token;
    this.allowedUserId = allowedUserId;       // numeric Telegram user id, or null = first sender registers
    this.allowedChannelId = allowedChannelId; // numeric channel id (negative number, e.g. -1001234567890), or null
    this.onBatch = onBatch;                   // async ({ chatId, userId, msgId, caption, images: [...], source: 'user'|'channel' }) => void
    this.onLog = onLog || (() => {});
    this.running = false;
    this.abortCtrl = null;
    this.offset = 0;
    this.pending = new Map(); // group key → { timer, msgs, chatId, userId, caption, source }
  }

  api(method) {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      const stored = await chrome.storage.local.get(STORE_OFFSET_KEY);
      this.offset = stored[STORE_OFFSET_KEY] ?? 0;
    } catch (_) {}
    this.onLog(`relay: started (offset=${this.offset}) ` +
      `userId=${this.allowedUserId ?? 'auto'} channelId=${this.allowedChannelId ?? 'none'}`);
    this._loop().catch(err => this.onLog(`relay loop crashed: ${err.message ?? err}`));
  }

  stop() {
    this.running = false;
    try { this.abortCtrl?.abort(); } catch (_) {}
    this.onLog('relay: stopped');
  }

  async _loop() {
    while (this.running) {
      this.abortCtrl = new AbortController();
      try {
        // If a channel ID is configured, also subscribe to channel_post
        // updates — that's how iPhone Shortcut → bot → channel works
        // (Bot API can't impersonate users in private chats, but it CAN
        // post to channels where it's admin, and those posts arrive as
        // channel_post updates).
        const allowed = this.allowedChannelId ? ['message', 'channel_post'] : ['message'];
        const url = this.api('getUpdates') +
          `?timeout=${LONG_POLL_TIMEOUT_S}&offset=${this.offset}` +
          `&allowed_updates=${encodeURIComponent(JSON.stringify(allowed))}`;
        const res = await fetch(url, { signal: this.abortCtrl.signal });
        if (!res.ok) {
          if (res.status === 401) {
            this.onLog('relay: 401 — bad bot token. Stopping.');
            this.running = false;
            break;
          }
          if (res.status === 409) {
            // Another getUpdates is running (or webhook set). Back off.
            this.onLog('relay: 409 conflict, backing off 5s');
            await sleep(5000);
            continue;
          }
          this.onLog(`relay: HTTP ${res.status}, retrying in 3s`);
          await sleep(3000);
          continue;
        }
        const data = await res.json();
        if (!data.ok) {
          this.onLog(`relay: api err ${data.description}`);
          await sleep(3000);
          continue;
        }
        for (const upd of data.result) {
          this.offset = Math.max(this.offset, upd.update_id + 1);
          // Diagnostic: log every incoming update's type + chat id, BEFORE
          // the auth filter rejects it. Lets us tell whether posts are
          // arriving but getting dropped vs. never arriving at all.
          const m = upd.message || upd.channel_post;
          if (m) {
            const kind = upd.channel_post ? 'channel_post' : 'message';
            const fromBit = upd.message?.from?.id ? ` from=${upd.message.from.id}` : '';
            const photoBit = m.photo ? ` photos=${m.photo.length}` : '';
            this.onLog(`recv: ${kind} chat=${m.chat.id}${fromBit}${photoBit}`);
          } else {
            this.onLog(`recv: ${Object.keys(upd).filter(k => k !== 'update_id').join(',')}`);
          }
          await this._handleUpdate(upd);
        }
        if (data.result.length > 0) {
          try { await chrome.storage.local.set({ [STORE_OFFSET_KEY]: this.offset }); } catch (_) {}
        }
      } catch (err) {
        if (err.name === 'AbortError') break;
        this.onLog(`relay: fetch err ${err.message ?? err}`);
        await sleep(3000);
      }
    }
  }

  async _handleUpdate(upd) {
    const msg = upd.message || upd.channel_post;
    if (!msg) return;
    const isChannel = !!upd.channel_post;
    const source = isChannel ? 'channel' : 'user';

    // ---- Authorization filter ---------------------------------------
    // The "Channel ID" field is really a "trusted chat" — accept any
    // message in that chat regardless of sender (covers channel posts,
    // user-sent group messages where the bot is a member, and edits).
    // For private chats we still apply the per-user allowlist.
    let actorId;
    const trustedChat = this.allowedChannelId &&
      msg.chat.id === Number(this.allowedChannelId);

    if (trustedChat) {
      actorId = msg.chat.id;
    } else if (isChannel) {
      // Channel post from a channel we don't trust — drop.
      return;
    } else {
      const fromId = msg.from?.id;
      if (!fromId) return;
      if (!this.allowedUserId) {
        // First-message auto-pin in private chat
        this.allowedUserId = fromId;
        try { await chrome.storage.local.set({ 'tgRelay.allowedUserId': fromId }); } catch (_) {}
        this._reply(msg.chat.id, `✅ Bound to user ${fromId}. Send a photo whenever you want.`);
      }
      if (fromId !== this.allowedUserId) return;
      actorId = fromId;
    }

    // ---- Photo batch handling ---------------------------------------
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      // Group key prefix differs by source so a private-chat batch never
      // collides with a channel batch sent within the same window.
      const prefix = isChannel ? 'ch' : 'loose';
      const groupId = msg.media_group_id || `${prefix}:${msg.chat.id}`;
      let entry = this.pending.get(groupId);
      if (!entry) {
        entry = {
          chatId: msg.chat.id,
          userId: actorId,
          msgId: msg.message_id,
          caption: msg.caption || '',
          fileIds: [],
          source,
          timer: null
        };
        this.pending.set(groupId, entry);
      }
      entry.fileIds.push(largest.file_id);
      if (msg.caption) entry.caption = msg.caption;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this._finalizeBatch(groupId), BATCH_DEBOUNCE_MS);
      return;
    }

    // ---- Text command handling (private chats only) -----------------
    if (!isChannel && msg.text) {
      const t = msg.text.trim().toLowerCase();
      if (t === '/start' || t === '/ping') {
        this._reply(msg.chat.id, `pong · listening · user_id ${actorId}` +
          (this.allowedChannelId ? ` · channel ${this.allowedChannelId}` : ''));
      } else if (t === '/stop') {
        this._reply(msg.chat.id, 'Use the extension UI to stop the poller.');
      } else {
        this._reply(msg.chat.id, 'Send photos here, or post them to the configured channel for one-tap mode.');
      }
    }
  }

  async _finalizeBatch(groupId) {
    const entry = this.pending.get(groupId);
    if (!entry) return;
    this.pending.delete(groupId);

    this.onLog(`relay: batch ${groupId} (${entry.fileIds.length} photos) → downloading`);

    let images;
    try {
      images = await Promise.all(entry.fileIds.map(id => this._downloadPhoto(id)));
    } catch (err) {
      this.onLog(`relay: download failed: ${err.message ?? err}`);
      this._reply(entry.chatId, `❌ Download failed: ${err.message ?? err}`);
      return;
    }

    try {
      await this.onBatch({
        chatId: entry.chatId,
        userId: entry.userId,
        msgId: entry.msgId,
        caption: entry.caption,
        source: entry.source,
        images
      });
    } catch (err) {
      this.onLog(`relay: onBatch threw: ${err.message ?? err}`);
      this._reply(entry.chatId, `❌ Pipeline error: ${err.message ?? err}`);
    }
  }

  async _downloadPhoto(fileId) {
    const fileRes = await fetch(this.api('getFile') + `?file_id=${encodeURIComponent(fileId)}`);
    const fileJson = await fileRes.json();
    if (!fileJson.ok) throw new Error(`getFile failed: ${fileJson.description}`);
    const filePath = fileJson.result.file_path;
    const dlUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const r = await fetch(dlUrl);
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { name: `photo.${ext}`, type, base64 };
  }

  async _reply(chatId, text) {
    try {
      await fetch(this.api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
      });
    } catch (err) {
      this.onLog(`relay: reply failed: ${err.message ?? err}`);
    }
  }

  // Public helper so the orchestrator can echo status back into Telegram.
  async sendText(chatId, text) {
    return this._reply(chatId, text);
  }

  // Send a long answer to Telegram with formatting preserved. Markdown is
  // converted to Telegram HTML (<b>, <i>, <code>, <pre>), then split into
  // ~3800-char chunks at paragraph/line boundaries so the 4096 limit holds
  // even after HTML escaping inflates length a bit.
  async sendAnswerHtml(chatId, markdown) {
    const chunks = splitForTelegram(markdown, 3800);
    let sentCount = 0;
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      const res = await fetch(this.api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        // Fall back to plain text if Telegram rejects the HTML (e.g. a
        // tag pair we mis-balanced) — better to deliver unformatted than
        // to drop the whole answer.
        this.onLog(`relay: HTML send failed (${data.description}), retrying as plain`);
        const r2 = await fetch(this.api('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            disable_web_page_preview: true
          })
        });
        const d2 = await r2.json().catch(() => ({}));
        if (!d2.ok) throw new Error(`Telegram sendMessage failed: ${d2.description || 'unknown'}`);
      }
      sentCount++;
    }
    return { chunks: sentCount };
  }
}

// Split a long string into chunks <= maxLen at paragraph/line/space
// boundaries. Greedy from the left.
function splitForTelegram(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// Convert standard markdown into the small subset of HTML that Telegram
// understands (<b>, <i>, <s>, <code>, <pre>, <a>, <blockquote>). Anything
// else is HTML-escaped and dropped through.
function markdownToTelegramHtml(md) {
  // Use a placeholder unlikely to appear in normal text. Backtick-NULish
  // markers protect extracted code from later regex passes.
  const PH = '';
  const blocks = [];
  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(code.replace(/\n+$/, ''));
    return `${PH}CB${blocks.length - 1}${PH}`;
  });
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlines.push(code);
    return `${PH}IC${inlines.length - 1}${PH}`;
  });
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Headers → bold lines (Telegram has no heading tag).
  s = s.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '<b>$1</b>');
  // Bold (** or __ )
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  // Italic (single * or single _)
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
  // Strikethrough.
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  // Links [text](url).
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const safeUrl = u.replace(/"/g, '%22');
    return `<a href="${safeUrl}">${t}</a>`;
  });
  // Blockquote: group consecutive "> " lines into one <blockquote>.
  s = s.replace(/(^|\n)((?:&gt; .*(?:\n|$))+)/g, (_m, lead, lines) => {
    const cleaned = lines.split('\n')
      .map(l => l.replace(/^&gt; /, ''))
      .filter(Boolean)
      .join('\n');
    return `${lead}<blockquote>${cleaned}</blockquote>\n`;
  });
  // Restore inline code (escape inside).
  s = s.replace(new RegExp(`${PH}IC(\\d+)${PH}`, 'g'), (_m, i) => {
    const code = inlines[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${code}</code>`;
  });
  // Restore fenced blocks.
  s = s.replace(new RegExp(`${PH}CB(\\d+)${PH}`, 'g'), (_m, i) => {
    const code = blocks[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre>${code}</pre>`;
  });
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
