/** Ica relay protocol 2. See docs/relay.md for rollout, bounds and recovery.
 * Never deploy an older destructive-take relay over a v2 queue.
 */
const RELAY_PREFIX = 'U_';
const PC_ACTIVE_MS = 90000;
const LEASE_MS = 120000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const RECEIPT_AGE_MS = 7 * MAX_AGE_MS;
const MAX_ATTEMPTS = 5;
const MAX_PENDING = 64;
const MAX_RECORDS = 512;
const MAX_STORE_BYTES = 300000; // Reserve space below the shared 500 KB property-store limit.
const MAX_UPDATE_BYTES = 24000;

function relayProps() { return PropertiesService.getScriptProperties(); }

/** Point Telegram at this relay and print the WATCHER_RELAY secret. Safe to run again. */
function connectTelegram() {
  const props = relayProps();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const url = props.getProperty('WEB_APP_URL');
  if (!token) throw new Error('Add TELEGRAM_BOT_TOKEN under Project Settings → Script properties.');
  if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('Deploy as a web app, then add its …/exec URL as WEB_APP_URL.');
  let key = props.getProperty('RELAY_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); props.setProperty('RELAY_KEY', key); }
  const result = telegram('setWebhook', { url: `${url}?key=${key}`, allowed_updates: ['message', 'callback_query'], max_connections: 5 });
  if (!result.ok) throw new Error(`Telegram refused the webhook: ${result.description}`);
  console.log(`Connected. Add this as WATCHER_RELAY (GitHub secret and install.ps1 -Relay):\n${JSON.stringify({ url, key })}`);
}

/** Back to the old way: runners ask Telegram directly. */
function disconnectTelegram() {
  const result = telegram('deleteWebhook', { drop_pending_updates: false });
  console.log(result.ok ? 'Disconnected. Remove WATCHER_RELAY on GitHub and the PC.' : `Telegram said: ${result.description}`);
}

function telegram(method, payload) {
  const token = relayProps().getProperty('TELEGRAM_BOT_TOKEN');
  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  return JSON.parse(response.getContentText());
}

function relayBytes(text) { return Utilities.newBlob(text).getBytes().length; }
function relayJson(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function relayAuthorized(e, props) {
  const key = props.getProperty('RELAY_KEY');
  return !!key && !!e && !!e.parameter && e.parameter.key === key;
}
function relayChat(update) { return String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? ''); }
function relayNormalize(update) {
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('invalid update');
  const out = { update_id: update.update_id };
  if (update.message) {
    const m = update.message;
    if (!Number.isSafeInteger(m.chat?.id) || !Number.isSafeInteger(m.date) || (m.text !== undefined && typeof m.text !== 'string')) throw new Error('invalid message');
    out.message = { chat: { id: m.chat.id }, date: m.date };
    if (m.text !== undefined) out.message.text = m.text;
  } else if (update.callback_query) {
    const c = update.callback_query;
    if (typeof c.id !== 'string' || c.id.length > 256 || (c.data !== undefined && typeof c.data !== 'string')) throw new Error('invalid callback');
    out.callback_query = { id: c.id };
    if (c.data !== undefined) out.callback_query.data = c.data;
    if (c.message) {
      if (!Number.isSafeInteger(c.message.chat?.id) || !Number.isSafeInteger(c.message.message_id)) throw new Error('invalid callback message');
      out.callback_query.message = { chat: { id: c.message.chat.id }, message_id: c.message.message_id };
    }
  }
  return out;
}
function relayChunkKey(id, i) { return 'P_' + id + '_' + i; }
function relayDropPayload(props, id, entry) {
  for (let i = 0; i < (entry.chunks || 0); i++) props.deleteProperty(relayChunkKey(id, i));
}
function relayTerminal(props, id, entry, reason, now) {
  // Commit the terminal record before deleting payload; a crash cannot resurrect it.
  const terminal = { v: 2, at: entry.at, state: 'dead', reason, ended: now, chat: entry.chat || '', attempts: 0, notified: false };
  props.setProperty(RELAY_PREFIX + id, JSON.stringify(terminal));
  relayDropPayload(props, id, entry);
  return terminal;
}
function relayFault(props, reason, now) {
  // Even when admission is full, retain an explicit count-only fault for /status.
  // There is no claim that Apps Script exceptions produce an HTTP retry response.
  let old = {};
  try { old = JSON.parse(props.getProperty('RELAY_FAULT') || '{}'); } catch (error) {}
  props.setProperty('RELAY_FAULT', JSON.stringify({ reason, at: now, count: (old.count || 0) + 1 }));
}
function relayEntries(props, now) {
  const all = props.getProperties(), entries = {};
  for (const key of Object.keys(all)) {
    if (!/^U_\d+$/.test(key)) continue;
    const id = key.slice(2);
    let e;
    try { e = JSON.parse(all[key]); } catch (error) {}
    // Import the old queue, preserving its original acceptance time.
    if (e && !e.v && e.update) {
      try { e = relayStoreUpdate(props, relayNormalize(e.update), e.at, true); }
      catch (error) { relayFault(props, 'migration', now); throw new Error('legacy_migration_failed'); }
    }
    if (!e || e.v !== 2 || !Number.isFinite(e.at) || !['pending', 'done', 'dead'].includes(e.state)
      || (e.state === 'pending' && (!Number.isInteger(e.attempts) || e.attempts < 0 || e.attempts > MAX_ATTEMPTS))
      || (e.state !== 'pending' && !Number.isFinite(e.ended))) {
      e = relayTerminal(props, id, { at: now }, 'malformed', now);
    }
    if (e.state !== 'pending' && now - e.ended >= RECEIPT_AGE_MS) { props.deleteProperty(key); continue; }
    if (e.state === 'pending' && !(e.until > now)) {
      if (now - e.at >= MAX_AGE_MS) e = relayTerminal(props, id, e, 'expired', now);
      else if (e.attempts >= MAX_ATTEMPTS) e = relayTerminal(props, id, e, 'attempts_exhausted', now);
    }
    entries[id] = e;
  }
  // Recover orphan chunks from interrupted admission, migration or cleanup.
  for (const key of Object.keys(all)) {
    const match = /^P_(\d+)_(\d+)$/.exec(key);
    if (match && (!entries[match[1]] || entries[match[1]].state !== 'pending')) props.deleteProperty(key);
  }
  return entries;
}
function relayStoreUpdate(props, update, at, migrating) {
  const id = String(update.update_id), serialized = JSON.stringify(update);
  if (!Number.isFinite(at) || relayBytes(serialized) > MAX_UPDATE_BYTES) return relayTerminal(props, id, { at: Date.now(), chat: relayChat(update) }, 'oversized', Date.now());
  // Split on Unicode code points, never between a surrogate pair. Each chunk is at most 6 KB.
  const chunks = [], points = Array.from(serialized);
  for (let i = 0; i < points.length; i += 1500) chunks.push(points.slice(i, i + 1500).join(''));
  const entry = { v: 2, at, state: 'pending', attempts: 0, chunks: chunks.length, chat: relayChat(update) };
  const all = props.getProperties();
  const used = Object.entries(all).reduce((n, [k, v]) => n + relayBytes(k) + relayBytes(v), 0);
  // Includes headroom for claim tokens and terminal notices. Migration never deletes the old payload first.
  if (used + relayBytes(serialized) + 2000 > MAX_STORE_BYTES) {
    if (migrating) throw new Error('migration capacity');
    return relayTerminal(props, id, { at, chat: entry.chat }, 'capacity', Date.now());
  }
  chunks.forEach((chunk, i) => props.setProperty(relayChunkKey(id, i), chunk));
  props.setProperty(RELAY_PREFIX + id, JSON.stringify(entry)); // Acceptance commit marker, written last.
  return entry;
}

/** Telegram gets 200 only after recording acceptance or an explicit terminal rejection. */
function doPost(e) {
  const props = relayProps();
  if (!relayAuthorized(e, props)) return HtmlService.createHtmlOutput('no');
  const now = Date.now(), lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let update;
    try { update = relayNormalize(JSON.parse(e.postData.contents)); }
    catch (error) { relayFault(props, 'malformed', now); return HtmlService.createHtmlOutput('rejected'); }
    const entries = relayEntries(props, now), id = String(update.update_id);
    if (!entries[id]) {
      if (Object.keys(entries).length >= MAX_RECORDS) {
        relayFault(props, 'capacity', now);
        return HtmlService.createHtmlOutput('rejected');
      }
      if (Object.values(entries).filter(x => x.state === 'pending').length >= MAX_PENDING) {
        relayTerminal(props, id, { at: now, chat: relayChat(update) }, 'capacity', now);
      } else relayStoreUpdate(props, update, now, false);
    }
  } finally { lock.releaseLock(); }
  if (now - Number(props.getProperty('PC_SEEN_AT') || 0) > PC_ACTIVE_MS) requestMessagesRun();
  return HtmlService.createHtmlOutput('ok');
}

/** Claims one update/notice. A unique token fences ack/renew; polling never removes work. */
function doGet(e) {
  const props = relayProps();
  if (!relayAuthorized(e, props)) return relayJson({ error: 'forbidden' });
  const p = e.parameter, now = Date.now();
  if (p.action === 'take') return relayJson({ error: 'protocol_upgrade_required' });
  if (!['status', 'claim', 'renew', 'ack'].includes(p.action)) return relayJson({ error: 'unknown_action' });
  if (p.action !== 'status' && !['pc', 'cloud'].includes(p.who)) return relayJson({ error: 'invalid_runner' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const entries = relayEntries(props, now);
    if (p.action === 'status') {
      let fault = null;
      try { fault = JSON.parse(props.getProperty('RELAY_FAULT') || 'null'); } catch (error) {}
      return relayJson({ protocol: 2, pending: Object.values(entries).filter(x => x.state === 'pending').length,
        failed: Object.values(entries).filter(x => x.state === 'dead').length,
        pcSeenAt: Number(props.getProperty('PC_SEEN_AT') || 0), fault });
    }
    if (p.action === 'claim') {
      if (p.who === 'pc') props.setProperty('PC_SEEN_AT', String(now));
      if (p.who === 'cloud' && now - Number(props.getProperty('PC_SEEN_AT') || 0) <= PC_ACTIVE_MS) return relayJson({ protocol: 2, deliveries: [] });
      for (const id of Object.keys(entries).sort((a, b) => Number(a) - Number(b))) {
        let entry = entries[id];
        if (entry.until > now || entry.state === 'done' || (entry.state === 'dead' && (entry.notified || entry.attempts >= MAX_ATTEMPTS))) continue;
        let update;
        if (entry.state === 'pending') {
          try {
            let raw = '';
            if (!Number.isInteger(entry.chunks) || entry.chunks < 1 || entry.chunks > 32) throw new Error('invalid chunks');
            for (let i = 0; i < entry.chunks; i++) {
              const chunk = props.getProperty(relayChunkKey(id, i));
              if (chunk === null) throw new Error('missing chunk');
              raw += chunk;
            }
            update = relayNormalize(JSON.parse(raw));
            if (String(update.update_id) !== id) throw new Error('wrong identity');
          } catch (error) { entry = relayTerminal(props, id, entry, 'malformed', now); }
        }
        const token = Utilities.getUuid().replace(/-/g, '');
        entry = { ...entry, token, who: p.who, until: now + LEASE_MS, attempts: entry.attempts + 1 };
        props.setProperty(RELAY_PREFIX + id, JSON.stringify(entry));
        return relayJson({ protocol: 2, deliveries: [{ id, token, until: entry.until,
          ...(entry.state === 'dead' ? { failure: entry.reason, chat: entry.chat } : { update }) }] });
      }
      return relayJson({ protocol: 2, deliveries: [] });
    }
    if (!/^\d{1,16}$/.test(p.id || '') || !/^[a-f0-9]{32}$/.test(p.token || '')) return relayJson({ error: 'invalid_claim' });
    const entry = entries[p.id];
    // Lost ACK responses may repeat an already-committed ACK, but never renew it.
    if (p.action === 'ack' && entry && entry.token === p.token && entry.who === p.who && (entry.state === 'done' || entry.notified)) return relayJson({ protocol: 2, ok: true });
    if (!entry || entry.token !== p.token || entry.who !== p.who || !(entry.until > now)) return relayJson({ error: 'stale_claim' });
    if (p.action === 'renew') {
      if (entry.state === 'done' || entry.notified) return relayJson({ error: 'stale_claim' });
      entry.until = now + LEASE_MS;
      if (p.who === 'pc') props.setProperty('PC_SEEN_AT', String(now));
    } else {
      if (entry.state === 'dead') entry.notified = true;
      else { entry.state = 'done'; entry.ended = now; }
    }
    props.setProperty(RELAY_PREFIX + p.id, JSON.stringify(entry));
    if (p.action === 'ack') relayDropPayload(props, p.id, entry);
    return relayJson({ protocol: 2, ok: true });
  } finally { lock.releaseLock(); }
}

/** Failure to wake GitHub does not undo admission; the existing timer retries. */
function requestMessagesRun() {
  const props = relayProps(), token = props.getProperty('GITHUB_TOKEN');
  if (!token) return;
  const repo = props.getProperty('WATCHER_REPO') || 'kevanwee/voracity-watcher';
  try {
    const response = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/actions/workflows/watch.yml/dispatches`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      payload: JSON.stringify({ ref: 'main', inputs: { messages: 'true' } }),
    });
    if (response.getResponseCode() !== 204) relayFault(props, 'dispatch', Date.now());
  } catch (error) { relayFault(props, 'dispatch', Date.now()); }
}

/** Run in the private Apps Script editor: counts/reasons only, never secrets or message bodies. */
function relayHealth() {
  const result = doGet({ parameter: { key: relayProps().getProperty('RELAY_KEY'), action: 'status' } });
  console.log(result.getContent());
}
