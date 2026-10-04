/**
 * Ica's Telegram relay: replies in about 30 seconds while your PC is off.
 *
 * Telegram pushes each message here the moment you send it (a webhook). The relay keeps
 * it in a small queue and asks GitHub to run Ica right away, unless your PC is already
 * collecting messages (it checks every few seconds, so it replies almost instantly).
 * Runners collect queued messages with a key; nothing is answered here.
 *
 * Add this file to the same Apps Script project as wake.gs (it shares GITHUB_TOKEN), then:
 *   1. Project Settings → Script properties: add TELEGRAM_BOT_TOKEN (from @BotFather).
 *   2. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *      Copy the web app URL and add it as the WEB_APP_URL script property.
 *   3. Run connectTelegram. It prints a line like {"url":"…","key":"…"}: add it as the
 *      WATCHER_RELAY secret on GitHub and on your PC (install.ps1 -Relay '<that line>').
 * To go back to the old way, run disconnectTelegram.
 */
const RELAY_PREFIX = 'U_';
/** While the PC has collected messages within this long, it is the one replying. */
const PC_ACTIVE_MS = 20000;
/** Messages older than this are dropped rather than answered very late. */
const MAX_AGE_MS = 24 * 3600 * 1000;

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

/** Telegram delivers here. HtmlService (not ContentService) so Telegram gets a 200, not a redirect. */
function doPost(e) {
  const props = relayProps();
  if (!e || !e.parameter || e.parameter.key !== props.getProperty('RELAY_KEY')) return HtmlService.createHtmlOutput('no');
  let update;
  try { update = JSON.parse(e.postData.contents); } catch (error) { return HtmlService.createHtmlOutput('ok'); }
  if (typeof update.update_id !== 'number') return HtmlService.createHtmlOutput('ok');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // One property per message: each value may hold up to 9 KB, more than a Telegram message needs.
    props.setProperty(RELAY_PREFIX + update.update_id, JSON.stringify({ at: Date.now(), update }));
  } finally { lock.releaseLock(); }
  const pcSeen = Number(props.getProperty('PC_SEEN_AT') || 0);
  if (Date.now() - pcSeen > PC_ACTIVE_MS) requestMessagesRun();
  return HtmlService.createHtmlOutput('ok');
}

/** Runners collect messages here: ?key=…&action=take&who=pc|cloud, or action=status. */
function doGet(e) {
  const props = relayProps();
  const json = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  if (!e || !e.parameter || e.parameter.key !== props.getProperty('RELAY_KEY')) return json({ error: 'forbidden' });
  if (e.parameter.action === 'status') {
    return json({ pending: Object.keys(props.getProperties()).filter(k => k.indexOf(RELAY_PREFIX) === 0).length, pcSeenAt: Number(props.getProperty('PC_SEEN_AT') || 0) });
  }
  if (e.parameter.action !== 'take') return json({ error: 'unknown action' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (e.parameter.who === 'pc') props.setProperty('PC_SEEN_AT', String(Date.now()));
    const all = props.getProperties(), updates = [];
    for (const key of Object.keys(all)) {
      if (key.indexOf(RELAY_PREFIX) !== 0) continue;
      const entry = JSON.parse(all[key]);
      props.deleteProperty(key);
      if (Date.now() - entry.at <= MAX_AGE_MS) updates.push(entry.update);
    }
    updates.sort((a, b) => a.update_id - b.update_id);
    return json({ updates });
  } finally { lock.releaseLock(); }
}

/** A message-only run: it skips site checks, so it replies sooner. */
function requestMessagesRun() {
  const props = relayProps();
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) return;
  const repo = props.getProperty('WATCHER_REPO') || 'kevanwee/voracity-watcher';
  UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/actions/workflows/watch.yml/dispatches`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: 'main', inputs: { messages: 'true' } }),
  });
}
