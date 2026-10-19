/** Ica mail watcher. Install in a SEPARATE PRIVATE Apps Script project.
 * See docs/email-watcher.md. Never add this to the public Telegram web app.
 * No mailbox data or OAuth credentials pass through GitHub or Firestore.
 */
const MAIL_DEFAULT_RULES = {
  words: ['masters', 'llm'], phrases: ['master of laws'],
  senders: ['llm.admissions@smu.edu.sg', 'masters.admissions@smu.edu.sg'],
};
const MAIL_OVERLAP_MS = 10 * 60 * 1000;
const MAIL_RECEIPT_LIMIT = 1500;

function mailProps() { return PropertiesService.getScriptProperties(); }
function mailJson(key, fallback) {
  const raw = mailProps().getProperty(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { throw new Error('invalid_private_configuration'); }
}
function mailSave(key, value) {
  const text = JSON.stringify(value);
  if (Utilities.newBlob(text).getBytes().length > 8000) throw new Error('mail_state_capacity');
  mailProps().setProperty(key, text);
}
function mailRules() {
  const rules = mailJson('MAIL_RULES', MAIL_DEFAULT_RULES);
  for (const key of ['words', 'phrases', 'senders']) {
    if (!Array.isArray(rules[key]) || rules[key].length > 30 || rules[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) {
      throw new Error('invalid_mail_rules');
    }
  }
  if (!rules.words.length && !rules.phrases.length && !rules.senders.length) throw new Error('empty_mail_rules');
  return rules;
}
function mailNormalize(text) { return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\u200b]+/g, ' ').trim(); }
function mailAddress(from) {
  const match = String(from || '').match(/<([^<>]+)>/);
  return mailNormalize(match ? match[1] : from);
}
function mailMatches(message, rules) {
  if (rules.senders.some(s => mailAddress(s) === mailAddress(message.from))) return true;
  const text = mailNormalize(message.subject + '\n' + message.body);
  const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...rules.words, ...rules.phrases].some(w => new RegExp('(^|[^\\p{L}\\p{N}_])' + escape(mailNormalize(w)) + '($|[^\\p{L}\\p{N}_])', 'u').test(text));
}
function mailPlain(html) {
  return String(html || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|tr|td|li|h[1-6]))>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }).replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, n) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n.toLowerCase()]);
}
function mailHash(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => (b & 255).toString(16).padStart(2, '0')).join('');
}
function mailFetch(url, options, service) {
  let response;
  try { response = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, followRedirects: false }, options)); }
  catch (e) { throw new Error(service + '_network'); }
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const error = new Error(service + '_http_' + status);
    error.status = status;
    // Respect provider/Telegram Retry-After without logging their response bodies.
    const headers = response.getAllHeaders();
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
    const retry = key && String(headers[key]);
    error.retryAt = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
    if (service === 'telegram') {
      try {
        const seconds = Number(JSON.parse(response.getContentText()).parameters?.retry_after);
        if (seconds > 0) error.retryAt = Math.max(error.retryAt || 0, Date.now() + seconds * 1000);
      } catch (ignored) {}
    }
    throw error;
  }
  try { return JSON.parse(response.getContentText()); }
  catch (e) { throw new Error(service + '_invalid_response'); }
}
function mailGmail(path) {
  return mailFetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path,
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }, 'gmail');
}
function mailTelegram(text) {
  const props = mailProps(), token = props.getProperty('TELEGRAM_BOT_TOKEN'), chat = props.getProperty('MAIL_CHAT_ID');
  if (!token || !/^[1-9]\d*$/.test(chat || '')) throw new Error('private_bot_and_chat_required');
  const until = Number(props.getProperty('MAIL_TELEGRAM_RETRY_AT')) || 0;
  if (until > Date.now()) {
    const error = new Error('telegram_backoff'); error.retryAt = until; throw error;
  }
  let result;
  try {
    result = mailFetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chat, text: text.slice(0, 3800), link_preview_options: { is_disabled: true } }),
    }, 'telegram');
  } catch (error) {
    if (error.retryAt > Date.now()) props.setProperty('MAIL_TELEGRAM_RETRY_AT', String(error.retryAt));
    throw error;
  }
  if (!result.ok) {
    const error = new Error('telegram_refused');
    error.retryAt = Date.now() + Math.max(60, Number(result.parameters?.retry_after) || 0) * 1000;
    props.setProperty('MAIL_TELEGRAM_RETRY_AT', String(error.retryAt));
    throw error;
  }
  props.deleteProperty('MAIL_TELEGRAM_RETRY_AT');
}
function mailStateKey(source) { return 'MAIL_STATE_' + source; }
function mailReceiptKey(source, id) { return 'MAIL_SENT_' + source + '_' + mailHash(id); }
function mailDeliver(source, message, rules, state) {
  if (!Number.isFinite(message.at)) throw new Error('invalid_message_date');
  if (message.at < state.startedAt || message.skip || !mailMatches(message, rules)) return false;
  const key = mailReceiptKey(source, message.id), props = mailProps();
  if (props.getProperty(key)) return false;
  if (Object.keys(props.getProperties()).filter(k => k.startsWith('MAIL_SENT_')).length >= MAIL_RECEIPT_LIMIT) throw new Error('mail_receipt_capacity');
  // Plain text only: message subjects cannot inject Telegram HTML, Markdown or buttons.
  mailTelegram('Doot Doot.\nNew matching email (' + source + ')\n' +
    String(message.subject || '(No subject)').replace(/[\r\n]/g, ' ').slice(0, 300) + '\nFrom: ' +
    String(message.from || '(Unknown sender)').replace(/[\r\n]/g, ' ').slice(0, 250) + '\n' +
    new Date(message.at).toISOString() + '\n\n' + message.url);
  // Commit only after Telegram accepts. A timeout or crash between these operations
  // can duplicate an alert, but never silently acknowledges a failed send.
  props.setProperty(key, String(message.at));
  return true;
}
function mailGmailMessage(raw) {
  const headers = raw.payload?.headers || [];
  const header = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';
  const bodies = [];
  function visit(part) {
    if (!part || part.filename || /^attachment/i.test((part.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '')) return;
    if (['text/plain', 'text/html'].includes(part.mimeType)) {
      if (!part.body?.data && part.body?.attachmentId) throw new Error('gmail_body_requires_download');
      if (part.body?.data) {
        const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8');
        bodies.push(part.mimeType === 'text/html' ? mailPlain(decoded) : decoded);
      }
    }
    (part.parts || []).forEach(visit);
  }
  visit(raw.payload);
  return { id: raw.id, at: Number(raw.internalDate), subject: header('subject'), from: header('from'), body: bodies.join('\n'),
    skip: (raw.labelIds || []).some(l => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(l)),
    url: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(mailProps().getProperty('MAIL_GMAIL_ACCOUNT')) + '#all/' + raw.id };
}
function mailGmailPage(state, rules) {
  state.pending = true;
  const path = 'history?historyTypes=messageAdded&maxResults=25&startHistoryId=' + encodeURIComponent(state.cursor) +
    (state.next ? '&pageToken=' + encodeURIComponent(state.next) : '');
  const result = mailGmail(path);
  if (!result.historyId || (result.history && !Array.isArray(result.history))) throw new Error('gmail_invalid_history');
  let sent = 0;
  for (const history of result.history || []) {
    if (!/^\d+$/.test(String(history.id))) throw new Error('gmail_invalid_history');
    // History records are immutable and ordered. Keep an in-record checkpoint as
    // well as a page token so large nonmatching batches make progress after timeout.
    const prior = state.progress;
    if (prior && (String(history.id).length < prior.history.length ||
      (String(history.id).length === prior.history.length && String(history.id) < prior.history))) continue;
    const added = history.messagesAdded || [];
    for (let index = prior?.history === String(history.id) ? prior.index : 0; index < added.length; index++) {
      if (Date.now() >= state.deadline) { mailSave(mailStateKey('gmail'), state); return { complete: false, sent }; }
      const id = added[index].message.id;
      if (!mailProps().getProperty(mailReceiptKey('gmail', id))) {
        let raw;
        try { raw = mailGmail('messages/' + encodeURIComponent(id) + '?format=full'); }
        catch (e) { if (e.status !== 404) throw e; } // Deleted between history and fetch.
        if (raw && mailDeliver('gmail', mailGmailMessage(raw), rules, state)) sent++;
      }
      state.progress = { history: String(history.id), index: index + 1 };
      mailSave(mailStateKey('gmail'), state);
    }
  }
  delete state.progress;
  if (result.nextPageToken) state.next = result.nextPageToken;
  else { state.cursor = String(result.historyId); delete state.next; delete state.pending; state.checkedAt = Date.now(); }
  mailSave(mailStateKey('gmail'), state);
  return { complete: !result.nextPageToken, sent };
}

function mailMicrosoftConfig() {
  const props = mailProps(), client = props.getProperty('MAIL_MICROSOFT_CLIENT_ID'), tenant = props.getProperty('MAIL_MICROSOFT_TENANT') || 'organizations';
  if (!/^[0-9a-f-]{36}$/i.test(client || '') || !/^(organizations|consumers|common|[0-9a-f-]{36}|[a-z0-9.-]+)$/i.test(tenant)) throw new Error('microsoft_app_configuration_required');
  return { client, base: 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/' };
}
function mailTokenRequest(payload) {
  const config = mailMicrosoftConfig();
  return mailFetch(config.base + 'token', { method: 'post', payload: Object.assign({ client_id: config.client }, payload) }, 'microsoft_auth');
}
function mailOutlookToken() {
  const saved = mailJson('MAIL_MICROSOFT_TOKEN', null);
  if (!saved?.refresh_token) throw new Error('outlook_sign_in_required');
  if (saved.account !== mailNormalize(mailProps().getProperty('MAIL_OUTLOOK_ACCOUNT'))) throw new Error('wrong_microsoft_account');
  if (saved.expiresAt > Date.now() + 60000) return saved.access_token;
  const result = mailTokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refresh_token });
  if (!result.access_token) throw new Error('microsoft_invalid_token');
  mailSave('MAIL_MICROSOFT_TOKEN', { account: saved.account, access_token: result.access_token, refresh_token: result.refresh_token || saved.refresh_token,
    expiresAt: Date.now() + Number(result.expires_in) * 1000 });
  return result.access_token;
}
function mailGraph(url, token) {
  // nextLink/webLink are untrusted provider data. Never send a bearer token off-host.
  if (!/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages(?:\?|$)/.test(url)) throw new Error('unsafe_graph_page');
  return mailFetch(url, { headers: { Authorization: 'Bearer ' + token, Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } }, 'outlook');
}
function mailOutlookPage(state, rules) {
  if (!state.until) state.until = Date.now();
  const token = mailOutlookToken();
  if (!state.excludedFolders) {
    state.excludedFolders = ['sentitems', 'drafts', 'junkemail', 'deleteditems'].map(folder => {
      const result = mailFetch('https://graph.microsoft.com/v1.0/me/mailFolders/' + folder + '?$select=id',
        { headers: { Authorization: 'Bearer ' + token, Prefer: 'IdType="ImmutableId"' } }, 'outlook');
      if (!result.id) throw new Error('outlook_invalid_folder');
      return result.id;
    });
  }
  const filter = 'receivedDateTime ge ' + new Date(Math.max(state.startedAt, state.cursor - MAIL_OVERLAP_MS)).toISOString() +
    ' and receivedDateTime lt ' + new Date(state.until).toISOString() + ' and isDraft eq false';
  const url = state.next || 'https://graph.microsoft.com/v1.0/me/messages?$top=25&$orderby=receivedDateTime%20asc&$select=id,subject,from,body,receivedDateTime,webLink,isDraft,parentFolderId&$filter=' + encodeURIComponent(filter);
  const result = mailGraph(url, token);
  if (!Array.isArray(result.value)) throw new Error('outlook_invalid_messages');
  let sent = 0;
  for (const raw of result.value) {
    if (Date.now() >= state.deadline) { mailSave(mailStateKey('outlook'), state); return { complete: false, sent }; }
    const message = { id: raw.id, at: Date.parse(raw.receivedDateTime), subject: raw.subject, from: raw.from?.emailAddress?.address || '',
      body: raw.body?.contentType?.toLowerCase() === 'html' ? mailPlain(raw.body.content) : raw.body?.content || '', skip: raw.isDraft || state.excludedFolders.includes(raw.parentFolderId),
      url: /^https:\/\/outlook\.(office\.com|office365\.com|live\.com)\//.test(raw.webLink || '') ? raw.webLink : 'https://outlook.office.com/mail/' };
    if (!message.id) throw new Error('outlook_invalid_message');
    if (mailDeliver('outlook', message, rules, state)) sent++;
  }
  if (result['@odata.nextLink']) state.next = result['@odata.nextLink'];
  else { state.cursor = state.until; state.checkedAt = Date.now(); delete state.until; delete state.next; delete state.excludedFolders; }
  mailSave(mailStateKey('outlook'), state);
  return { complete: !state.next, sent };
}
function mailPrune(source, state) {
  // Never expire receipts for an unfinished scan: a later page failure must not
  // turn already delivered messages into a new alert on retry.
  if (state.next || state.until || state.pending) return;
  const floor = source === 'gmail' ? state.checkedAt - 7 * 86400000 : state.cursor - MAIL_OVERLAP_MS - 86400000;
  const props = mailProps(), all = props.getProperties();
  for (const key of Object.keys(all)) if (key.startsWith('MAIL_SENT_' + source + '_') && Number(all[key]) < floor) props.deleteProperty(key);
}
function mailWithLock(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { return action(); } finally { lock.releaseLock(); }
}

/** Run after adding private properties. Idempotent; never resets existing cursors. */
function installMailWatcher() {
  return mailWithLock(() => {
    const props = mailProps(); mailRules();
    if (!props.getProperty('TELEGRAM_BOT_TOKEN') || !/^[1-9]\d*$/.test(props.getProperty('MAIL_CHAT_ID') || '')) throw new Error('private_bot_and_chat_required');
    const account = props.getProperty('MAIL_GMAIL_ACCOUNT');
    if (account) {
      const profile = mailGmail('profile');
      if (mailNormalize(profile.emailAddress) !== mailNormalize(account)) throw new Error('wrong_google_account');
      if (!mailJson(mailStateKey('gmail'), null)) mailSave(mailStateKey('gmail'), { startedAt: Date.now(), cursor: String(profile.historyId) });
    }
    if (props.getProperty('MAIL_OUTLOOK_ACCOUNT') && !mailJson(mailStateKey('outlook'), null)) throw new Error('connect_outlook_first');
    if (!account && !props.getProperty('MAIL_OUTLOOK_ACCOUNT')) throw new Error('mailbox_required');
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'checkMail')) ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(5).create();
    console.log('Mail watcher installed. New messages only; existing mail was not sent.');
  });
}
/** Trigger entry point. Mailbox failures are isolated and reported without content. */
function checkMail() {
  return mailWithLock(() => {
    const rules = mailRules(), props = mailProps(), deadline = Date.now() + 240000;
    for (const source of ['gmail', 'outlook']) {
      if (Date.now() >= deadline) break;
      if (!props.getProperty(source === 'gmail' ? 'MAIL_GMAIL_ACCOUNT' : 'MAIL_OUTLOOK_ACCOUNT')) continue;
      const state = mailJson(mailStateKey(source), null);
      if (!state) throw new Error('install_mail_watcher_first');
      const oldHealth = mailJson('MAIL_HEALTH_' + source, {});
      if (oldHealth.retryAt > Date.now()) continue;
      let sent = 0;
      try {
        // Gmail identity is rechecked on every run; trigger creators own its consent.
        if (source === 'gmail' && mailNormalize(mailGmail('profile').emailAddress) !== mailNormalize(props.getProperty('MAIL_GMAIL_ACCOUNT'))) throw new Error('wrong_google_account');
        state.deadline = Math.min(deadline, Date.now() + 110000);
        for (let page = 0; page < 3 && Date.now() < state.deadline; page++) {
          const result = source === 'gmail' ? mailGmailPage(state, rules) : mailOutlookPage(state, rules);
          sent += result.sent;
          if (result.complete) { mailPrune(source, state); break; }
        }
        mailSave('MAIL_HEALTH_' + source, { at: Date.now(), sent, backlog: !!(state.next || state.until || state.pending), checkedAt: state.checkedAt || null });
      } catch (e) {
        // Never expose arbitrary exception messages (Apps Script may include URLs/tokens).
        const fault = /^[a-z_]+(?:_http_\d{3})?$/.test(e.message || '') ? e.message : 'mail_check_failed';
        const health = { at: Date.now(), fault, retryAt: Math.max(Date.now() + 300000, Number(e.retryAt) || 0), notified: oldHealth.fault === fault && oldHealth.notified === true };
        if (!health.notified && !fault.startsWith('telegram_')) {
          try { mailTelegram('Doot Doot.\nEmail watcher needs attention (' + source + '): ' + fault + '.\nOpen the private Apps Script project and run mailHealth.'); health.notified = true; } catch (ignored) {}
        }
        mailSave('MAIL_HEALTH_' + source, health);
        console.log('Mail check failed (' + source + '); inspect mailHealth.');
      }
    }
  });
}
/** Stops this trigger only; retains checkpoints and credentials for resuming. */
function stopMailWatcher() {
  mailWithLock(() => ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'checkMail').forEach(t => ScriptApp.deleteTrigger(t)));
}
/** Private editor only: timestamps and fixed fault codes, never addresses/tokens. */
function mailHealth() {
  for (const source of ['gmail', 'outlook']) console.log(source + ': ' + JSON.stringify(mailJson('MAIL_HEALTH_' + source, { status: 'not_checked' })));
}
/** Explicit smoke test; does not read or mark any mail as delivered. */
function testMailNotification() { mailTelegram('Doot Doot.\nEmail watcher test. No email content is included.'); }

/** Start Microsoft consent only when the owner deliberately runs this function. */
function beginOutlookConnection() {
  return mailWithLock(() => {
    if (!mailProps().getProperty('MAIL_OUTLOOK_ACCOUNT')) throw new Error('outlook_account_required');
    const config = mailMicrosoftConfig();
    const result = mailFetch(config.base + 'devicecode', { method: 'post', payload: { client_id: config.client, scope: 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read offline_access' } }, 'microsoft_auth');
    if (!result.device_code || !result.user_code || result.verification_uri !== 'https://microsoft.com/devicelogin') throw new Error('invalid_device_response');
    mailSave('MAIL_MICROSOFT_DEVICE', { code: result.device_code, expiresAt: Date.now() + result.expires_in * 1000, nextAt: Date.now() + result.interval * 1000 });
    console.log('Open https://microsoft.com/devicelogin and enter ' + result.user_code + '. Sign in to the intended mailbox, then run finishOutlookConnection.');
  });
}
/** Run once after consenting. Deliberately no background polling of sign-in codes. */
function finishOutlookConnection() {
  return mailWithLock(() => {
    const props = mailProps(), device = mailJson('MAIL_MICROSOFT_DEVICE', null);
    if (!device || device.expiresAt < Date.now()) throw new Error('outlook_connection_expired');
    if (device.nextAt > Date.now()) throw new Error('outlook_wait_before_retry');
    // Conservatively space manual retries, including slow_down/authorization_pending.
    device.nextAt = Date.now() + 30000; mailSave('MAIL_MICROSOFT_DEVICE', device);
    const result = mailTokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.code });
    if (!result.access_token || !result.refresh_token) throw new Error('microsoft_invalid_token');
    const profile = mailFetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + result.access_token } }, 'outlook');
    const expected = mailNormalize(props.getProperty('MAIL_OUTLOOK_ACCOUNT'));
    if (![profile.mail, profile.userPrincipalName].some(v => v && mailNormalize(v) === expected)) throw new Error('wrong_microsoft_account');
    mailSave('MAIL_MICROSOFT_TOKEN', { account: expected, access_token: result.access_token, refresh_token: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 });
    props.deleteProperty('MAIL_MICROSOFT_DEVICE');
    if (!mailJson(mailStateKey('outlook'), null)) mailSave(mailStateKey('outlook'), { startedAt: Date.now(), cursor: Date.now() });
    console.log('Outlook connected. Run installMailWatcher to enable the timer.');
  });
}
/** Deletes Outlook's local tokens. Revoke consent separately in Microsoft account settings. */
function disconnectOutlook() {
  mailWithLock(() => {
    for (const key of ['MAIL_MICROSOFT_TOKEN', 'MAIL_MICROSOFT_DEVICE', 'MAIL_OUTLOOK_ACCOUNT']) mailProps().deleteProperty(key);
  });
}
/** Read-only preview of up to 50 Gmail candidates in the past 30 days. No Telegram sends.
 * Private editor logs include subject/sender links; never paste them into public logs.
 */
function previewGmailMatches() {
  const expected = mailProps().getProperty('MAIL_GMAIL_ACCOUNT');
  if (!expected || mailNormalize(mailGmail('profile').emailAddress) !== mailNormalize(expected)) throw new Error('wrong_google_account');
  const rules = mailRules();
  const terms = [...rules.words, ...rules.phrases].map(t => '"' + t.replace(/["\\]/g, '') + '"')
    .concat(rules.senders.map(s => 'from:' + s.replace(/[^a-zA-Z0-9@._+-]/g, '')));
  const result = mailGmail('messages?maxResults=50&q=' + encodeURIComponent('newer_than:30d -in:sent -in:drafts {' + terms.join(' ') + '}'));
  let count = 0;
  for (const item of result.messages || []) {
    const message = mailGmailMessage(mailGmail('messages/' + encodeURIComponent(item.id) + '?format=full'));
    if (!message.skip && mailMatches(message, rules)) { console.log(JSON.stringify({ subject: message.subject, from: message.from, url: message.url })); count++; }
  }
  console.log('Preview matches: ' + count + (result.nextPageToken ? ' (more candidates exist; preview is capped at 50).' : '.'));
}
