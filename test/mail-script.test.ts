import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const START = 1_800_000_000_000;
const account = 'owner@example.test';
const rules = { words: ['masters', 'llm'], phrases: ['master of laws'], senders: ['llm.admissions@smu.edu.sg', 'masters.admissions@smu.edu.sg'] };
type Reply = { body: any; status?: number; headers?: Record<string, string> };
function script(extra: Record<string, string> = {}) {
  const store = new Map(Object.entries({ TELEGRAM_BOT_TOKEN: 'private-token', MAIL_CHAT_ID: '42', MAIL_GMAIL_ACCOUNT: account, ...extra }));
  const calls: { url: string; options: any }[] = [], logs: string[] = [];
  const triggers: { getHandlerFunction: () => string }[] = [];
  let now = START, locked = false;
  let handler: (url: string, options: any) => Reply = url => {
    if (url.endsWith('/profile')) return { body: { emailAddress: account, historyId: '100' } };
    if (url.includes('/sendMessage')) return { body: { ok: true } };
    throw new Error('Unexpected request');
  };
  const props = { getProperty: (key: string) => store.get(key) ?? null, setProperty: (key: string, value: string) => {
    if (Buffer.byteLength(value) > 9000) throw new Error('Property too large');
    store.set(key, value);
  }, deleteProperty: (key: string) => store.delete(key), getProperties: () => Object.fromEntries(store) };
  const context: any = {
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => !locked, releaseLock: () => {} }) },
    ScriptApp: { getOAuthToken: () => 'ephemeral-google-token', getProjectTriggers: () => triggers,
      deleteTrigger: (t: any) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (name: string) => ({ timeBased() { return this; }, everyMinutes(n: number) { expect(n).toBe(5); return this; }, create() { triggers.push({ getHandlerFunction: () => name }); } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_: string, text: string) => [...createHash('sha256').update(text).digest()],
      base64DecodeWebSafe: (text: string) => Buffer.from(text, 'base64url'),
      newBlob: (text: string | Buffer) => ({ getBytes: () => [...Buffer.from(text)], getDataAsString: () => Buffer.from(text).toString('utf8') }) },
    UrlFetchApp: { fetch: (url: string, options: any) => {
      calls.push({ url, options });
      const response = handler(url, options);
      return { getResponseCode: () => response.status ?? 200, getContentText: () => JSON.stringify(response.body), getAllHeaders: () => response.headers ?? {} };
    } },
    Date: class extends Date { constructor(...args: any[]) { super(args.length ? args[0] : now); } static now() { return now; } },
    console: { log: (text: string) => logs.push(text) },
  };
  runInNewContext(readFileSync('scripts/apps-script/mail/mail.gs', 'utf8'), context);
  return { context, store, calls, logs, triggers, respond: (fn: typeof handler) => { handler = fn; }, advance: (ms: number) => { now += ms; }, lock: () => { locked = true; },
    json: (key: string) => JSON.parse(store.get(key) || 'null'), sent: () => calls.filter(c => c.url.includes('/sendMessage')).map(c => JSON.parse(c.options.payload)) };
}
function gmail(id: string, body = 'Master of Laws', extra: any = {}) {
  return { id, internalDate: String(START + 1000), labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Admissions <admission@example.test>' }, { name: 'Subject', value: 'Application received' }],
      body: { data: Buffer.from(body).toString('base64url') } }, ...extra };
}
function gmailResponses(s: ReturnType<typeof script>, messages: any[], send?: (options: any) => Reply) {
  s.respond((url, options) => {
    if (url.endsWith('/profile')) return { body: { emailAddress: account } };
    if (url.includes('/history?')) return { body: { historyId: '101', history: [{ id: '101', messagesAdded: messages.map(m => ({ message: { id: m.id } })) }] } };
    if (url.includes('/messages/')) return { body: messages.find(m => url.includes('/messages/' + m.id + '?')) };
    if (url.includes('/sendMessage')) return send ? send(options) : { body: { ok: true } };
    throw new Error('Unexpected request');
  });
}
function outlookScript() {
  const s = script({ MAIL_GMAIL_ACCOUNT: '', MAIL_OUTLOOK_ACCOUNT: account,
    MAIL_MICROSOFT_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
    MAIL_MICROSOFT_TOKEN: JSON.stringify({ account, access_token: 'outlook-token', refresh_token: 'refresh-secret', expiresAt: START + 3600000 }),
    MAIL_STATE_outlook: JSON.stringify({ startedAt: START, cursor: START }) });
  s.advance(60000);
  return s;
}
function graphMessage(id: string, extra: any = {}) {
  return { id, subject: 'LLM admissions', receivedDateTime: new Date(START + 1000).toISOString(), from: { emailAddress: { address: 'office@example.test' } },
    parentFolderId: 'inbox', body: { contentType: 'text', content: '' }, webLink: 'https://outlook.office.com/mail/read/' + id, ...extra };
}
function graphResponses(s: ReturnType<typeof script>, pages: (url: string, options: any) => Reply) {
  s.respond((url, options) => {
    if (url.includes('/mailFolders/')) return { body: { id: url.split('/mailFolders/')[1]!.split('?')[0] } };
    if (url.includes('/sendMessage')) return { body: { ok: true } };
    return pages(url, options);
  });
}

describe('Ica email matching', () => {
  it.each(['MASTERS admissions', 'LLM interview', 'A Master\n of  Laws offer', 'masters’ courses', 'my llm-related update'])('matches a whole word or phrase: %s', body => {
    expect(script().context.mailMatches({ body, subject: '', from: 'other@example.test' }, rules)).toBe(true);
  });
  it.each(['webmasters', 'masterson', 'llms', 'master of lawschool', 'normal newsletter'])('rejects incidental substrings: %s', body => {
    expect(script().context.mailMatches({ body, subject: '', from: 'other@example.test' }, rules)).toBe(false);
  });
  it('matches either exact sender, including mixed case and display names', () => {
    const c = script().context;
    for (const from of ['SMU <LLM.Admissions@smu.edu.sg>', 'masters.admissions@smu.edu.sg']) expect(c.mailMatches({ subject: '', body: '', from }, rules)).toBe(true);
    expect(c.mailMatches({ subject: '', body: '', from: 'llm.admissions@smu.edu.sg.evil.test' }, rules)).toBe(false);
    expect(c.mailMatches({ subject: '', body: '', from: 'llm.admissions@smu.edu.sg@evil.test' }, rules)).toBe(false);
  });
  it('matches text across inline HTML and entities, excluding script/style and attachments', () => {
    const c = script().context;
    const raw = gmail('1', '', { payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<style>llm</style><script>masters</script><p>mas<strong>ters</strong></p>').toString('base64url') } },
      { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('llm').toString('base64url') } },
    ] } });
    expect(c.mailGmailMessage(raw).body).toContain('masters');
    expect(c.mailPlain('<p>Master&nbsp;of&#32;Laws</p>')).toBe('Master of Laws ');
    expect(c.mailMatches({ subject: '', from: '', body: c.mailPlain('<script>llm</script><style>masters</style>hello') }, rules)).toBe(false);
  });
  it('allows private custom rules and refuses malformed or empty rules', () => {
    expect(script({ MAIL_RULES: '{"words":[],"phrases":["my course"],"senders":[]}' }).context.mailRules().phrases).toEqual(['my course']);
    expect(() => script({ MAIL_RULES: '{}' }).context.mailRules()).toThrow('invalid_mail_rules');
    expect(() => script({ MAIL_RULES: '{"words":[],"phrases":[],"senders":[]}' }).context.mailRules()).toThrow('empty_mail_rules');
  });
});

describe('Gmail lifecycle and delivery recovery', () => {
  it('baselines without old-mail notifications, installs one trigger and preserves its cursor on reinstall', () => {
    const s = script(); s.context.installMailWatcher(); s.context.installMailWatcher();
    expect(s.triggers).toHaveLength(1); expect(s.json('MAIL_STATE_gmail').cursor).toBe('100'); expect(s.sent()).toEqual([]);
    s.triggers.push({ getHandlerFunction: () => 'unrelated' }); s.context.stopMailWatcher();
    expect(s.triggers.map(t => t.getHandlerFunction())).toEqual(['unrelated']);
    expect(s.json('MAIL_STATE_gmail').cursor).toBe('100');
  });
  it('refuses a different Google account and skips concurrent invocations', () => {
    expect(() => script({ MAIL_GMAIL_ACCOUNT: 'someoneelse@example.test' }).context.installMailWatcher()).toThrow('wrong_google_account');
    const s = script(); s.lock(); s.context.installMailWatcher(); expect(s.calls).toEqual([]);
  });
  it('alerts new replies individually, deduplicates repeated events, ignores old and sent/spam/draft/trash messages', () => {
    const s = script(); s.context.installMailWatcher();
    const messages = [gmail('new'), gmail('reply'), gmail('old', 'llm', { internalDate: START - 1000 }),
      ...['SENT', 'SPAM', 'DRAFT', 'TRASH'].map(l => gmail(l, 'llm', { labelIds: [l] })), gmail('irrelevant', 'hello')];
    gmailResponses(s, messages); s.context.checkMail(); s.context.checkMail();
    expect(s.sent()).toHaveLength(2); expect(s.sent()[0].text).toMatch(/^Doot Doot\.\nNew matching email/);
    expect(s.sent()[0]).not.toHaveProperty('parse_mode'); expect(s.json('MAIL_STATE_gmail').cursor).toBe('101');
    expect([...s.store.values()].join(' ')).not.toContain('Master of Laws');
    expect([...s.store.values()].join(' ')).not.toContain('ephemeral-google-token');
  });
  it('does not advance the cursor on failed Telegram delivery; retries without repeating accepted sends', () => {
    const s = script(); s.context.installMailWatcher();
    let attempts = 0;
    gmailResponses(s, [gmail('a'), gmail('b')], () => ++attempts === 2 ? { status: 503, body: { error: 'private body' } } : { body: { ok: true } });
    s.context.checkMail(); expect(s.json('MAIL_STATE_gmail').cursor).toBe('100');
    expect(s.json('MAIL_HEALTH_gmail').fault).toBe('telegram_http_503');
    expect(s.sent()).toHaveLength(2); // No immediate error notice to a failing Telegram endpoint.
    s.advance(300001); s.context.checkMail();
    expect(s.sent()).toHaveLength(3); expect(s.json('MAIL_STATE_gmail').cursor).toBe('101');
    expect(s.logs.join()).not.toContain('private body');
  });
  it('honours Retry-After and resumes the same history checkpoint', () => {
    const s = script(); s.context.installMailWatcher();
    gmailResponses(s, [gmail('a')], () => ({ status: 429, headers: { 'Retry-After': '900' }, body: {} }));
    s.context.checkMail(); const calls = s.calls.length;
    s.advance(600000); s.context.checkMail(); expect(s.calls).toHaveLength(calls);
    expect(s.json('MAIL_HEALTH_gmail').retryAt).toBe(START + 900000);
    expect(s.json('MAIL_STATE_gmail').cursor).toBe('100');
  });
  it('preserves paginated history across the per-run page bound', () => {
    const s = script(); s.context.installMailWatcher();
    let page = 0;
    s.respond(url => {
      if (url.endsWith('/profile')) return { body: { emailAddress: account } };
      expect(url).toContain('startHistoryId=100');
      page++;
      return { body: { historyId: '200', ...(page < 4 ? { nextPageToken: 'page-' + page } : {}) } };
    });
    s.context.checkMail(); expect(s.json('MAIL_STATE_gmail').next).toBe('page-3');
    expect(s.json('MAIL_HEALTH_gmail').backlog).toBe(true);
    s.context.checkMail(); expect(s.json('MAIL_STATE_gmail').cursor).toBe('200'); expect(s.json('MAIL_STATE_gmail').next).toBeUndefined();
  });
  it('honours Telegram retry_after even without an HTTP header', () => {
    const s = script(); s.context.installMailWatcher();
    gmailResponses(s, [gmail('a')], () => ({ status: 429, body: { parameters: { retry_after: 1800 } } }));
    s.context.checkMail(); expect(s.json('MAIL_HEALTH_gmail').retryAt).toBe(START + 1800000);
    expect(s.sent()).toHaveLength(1);
  });
  it('shares Telegram backoff across mailboxes and explicit test sends', () => {
    const s = script(); s.context.installMailWatcher();
    gmailResponses(s, [gmail('a')], () => ({ status: 429, body: { parameters: { retry_after: 1800 } } }));
    s.context.checkMail();
    expect(() => s.context.mailDeliver('outlook', {
      id: 'outlook-a', at: START + 1000, subject: 'LLM', from: 'office@example.test', body: '', url: 'https://outlook.office.com/mail/',
    }, rules, { startedAt: START })).toThrow('telegram_backoff');
    expect(() => s.context.testMailNotification()).toThrow('telegram_backoff');
    expect(s.sent()).toHaveLength(1);
    expect(s.store.get('MAIL_TELEGRAM_RETRY_AT')).toBe(String(START + 1800000));
    s.advance(1800001);
    s.respond(() => ({ body: { ok: true } })); s.context.testMailNotification();
    expect(s.sent()).toHaveLength(2); expect(s.store.has('MAIL_TELEGRAM_RETRY_AT')).toBe(false);
  });
  it('resumes within a large nonmatching history record after its time budget', () => {
    const s = script(); s.context.installMailWatcher();
    const reads: string[] = [];
    s.respond(url => {
      if (url.endsWith('/profile')) return { body: { emailAddress: account } };
      if (url.includes('/history?')) return { body: { historyId: '101', history: [{ id: '101', messagesAdded: ['a', 'b'].map(id => ({ message: { id } })) }] } };
      const id = url.includes('/messages/a?') ? 'a' : 'b'; reads.push(id);
      if (id === 'a') s.advance(110001);
      return { body: gmail(id, 'unrelated mail') };
    });
    s.context.checkMail(); expect(s.json('MAIL_STATE_gmail').progress).toEqual({ history: '101', index: 1 });
    expect(s.json('MAIL_HEALTH_gmail').backlog).toBe(true);
    s.context.checkMail(); expect(reads).toEqual(['a', 'b']); expect(s.json('MAIL_STATE_gmail').cursor).toBe('101');
    expect(s.sent()).toEqual([]);
  });
  it('fails visibly on expired history rather than silently skipping mail', () => {
    const s = script(); s.context.installMailWatcher();
    s.respond(url => url.endsWith('/profile') ? { body: { emailAddress: account } } : url.includes('/sendMessage') ? { body: { ok: true } } : { status: 404, body: {} });
    s.context.checkMail(); expect(s.json('MAIL_STATE_gmail').cursor).toBe('100');
    expect(s.json('MAIL_HEALTH_gmail').fault).toBe('gmail_http_404'); expect(s.sent()).toHaveLength(1);
  });
  it('keeps receipts for failed scans and refuses capacity without losing the cursor', () => {
    const s = script(); s.context.installMailWatcher();
    for (let i = 0; i < 1500; i++) s.store.set('MAIL_SENT_gmail_' + i, String(START));
    gmailResponses(s, [gmail('new')]); s.context.checkMail();
    expect(s.json('MAIL_STATE_gmail').cursor).toBe('100'); expect(s.json('MAIL_HEALTH_gmail').fault).toBe('mail_receipt_capacity');
    expect(s.sent().filter(m => m.text.includes('New matching email'))).toEqual([]);
  });
  it('preview sends nothing and changes no checkpoints or read flags', () => {
    const s = script();
    s.respond(url => url.endsWith('/profile') ? { body: { emailAddress: account } } : url.includes('/messages?') ? { body: { messages: [{ id: 'test' }] } } : { body: gmail('test') });
    s.context.previewGmailMatches(); expect(s.sent()).toEqual([]); expect(s.json('MAIL_STATE_gmail')).toBeNull();
    expect(s.calls.every(c => !c.options.method || c.options.method === 'get')).toBe(true);
    expect(s.logs.join()).toContain('Preview matches: 1');
  });
});

describe('Outlook polling and private consent', () => {
  it('finds messages in custom folders, skips excluded folders and deduplicates the overlap', () => {
    const s = outlookScript();
    graphResponses(s, () => ({ body: { value: [graphMessage('a', { parentFolderId: 'custom' }), graphMessage('spam', { parentFolderId: 'junkemail' }), graphMessage('sent', { parentFolderId: 'sentitems' })] } }));
    s.context.checkMail(); s.context.checkMail(); expect(s.sent()).toHaveLength(1);
    expect(s.json('MAIL_STATE_outlook').cursor).toBe(START + 60000);
    const request = s.calls.find(c => c.url.includes('/me/messages'))!;
    expect(decodeURIComponent(request.url)).toContain('receivedDateTime ge');
    expect(request.options.headers.Prefer).toContain('ImmutableId');
  });
  it('preserves the bounded snapshot and nextLink and refuses off-host bearer-token requests', () => {
    const s = outlookScript();
    graphResponses(s, () => ({ body: { value: [], '@odata.nextLink': 'https://evil.test/steal' } }));
    s.context.checkMail();
    expect(s.calls.some(c => c.url.includes('evil.test'))).toBe(false);
    expect(s.json('MAIL_HEALTH_outlook').fault).toBe('unsafe_graph_page');
    expect(s.json('MAIL_STATE_outlook').cursor).toBe(START);
    expect(s.json('MAIL_STATE_outlook').until).toBe(START + 60000);
  });
  it('rotates Microsoft refresh tokens without logging them', () => {
    const s = outlookScript(); s.advance(3600000);
    graphResponses(s, url => url.endsWith('/token') ? { body: { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 } } : { body: { value: [] } });
    s.context.checkMail(); expect(s.json('MAIL_MICROSOFT_TOKEN').refresh_token).toBe('new-refresh');
    expect(s.logs.join()).not.toContain('new-refresh');
    s.context.disconnectOutlook(); expect(s.json('MAIL_MICROSOFT_TOKEN')).toBeNull(); expect(s.store.has('MAIL_OUTLOOK_ACCOUNT')).toBe(false);
  });
  it('binds Microsoft consent to the intended account and keeps tokens out of logs', () => {
    const s = outlookScript();
    s.store.delete('MAIL_MICROSOFT_TOKEN'); s.store.delete('MAIL_STATE_outlook');
    graphResponses(s, url => {
      if (url.endsWith('/devicecode')) return { body: { device_code: 'private-device', user_code: 'ABCD', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 } };
      if (url.endsWith('/token')) return { body: { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 } };
      return { body: { mail: 'wrong@example.test', userPrincipalName: 'wrong@example.test' } };
    });
    s.context.beginOutlookConnection(); s.advance(6000);
    expect(() => s.context.finishOutlookConnection()).toThrow('wrong_microsoft_account');
    expect(s.json('MAIL_MICROSOFT_TOKEN')).toBeNull(); expect(s.json('MAIL_STATE_outlook')).toBeNull();
    expect(s.logs.join()).not.toMatch(/private-access|private-refresh|private-device/);
  });
  it('runs Gmail even when Outlook consent is revoked and preserves its Outlook checkpoint', () => {
    const s = script(); s.context.installMailWatcher();
    s.store.set('MAIL_OUTLOOK_ACCOUNT', account); s.store.set('MAIL_STATE_outlook', JSON.stringify({ startedAt: START, cursor: START }));
    gmailResponses(s, [gmail('new')]); s.context.checkMail();
    expect(s.sent().some(m => m.text.includes('New matching email (gmail)'))).toBe(true);
    expect(s.json('MAIL_HEALTH_outlook').fault).toBe('outlook_sign_in_required'); expect(s.json('MAIL_STATE_outlook').cursor).toBe(START);
  });
  it('never reuses a Microsoft token after the configured mailbox changes', () => {
    const s = outlookScript(); s.store.set('MAIL_OUTLOOK_ACCOUNT', 'different@example.test');
    s.context.checkMail();
    expect(s.json('MAIL_HEALTH_outlook').fault).toBe('wrong_microsoft_account');
    expect(s.calls.some(c => c.url.includes('graph.microsoft.com'))).toBe(false);
  });
  it('completes the intended Microsoft connection without resetting existing history', () => {
    const s = outlookScript(); s.store.delete('MAIL_MICROSOFT_TOKEN');
    s.store.set('MAIL_MICROSOFT_DEVICE', JSON.stringify({ code: 'device-secret', expiresAt: START + 900000, nextAt: START }));
    graphResponses(s, url => url.endsWith('/token') ? { body: { access_token: 'new', refresh_token: 'refresh', expires_in: 3600 } } : { body: { mail: account } });
    s.context.finishOutlookConnection();
    expect(s.json('MAIL_MICROSOFT_TOKEN').account).toBe(account);
    expect(s.json('MAIL_STATE_outlook').cursor).toBe(START); expect(s.json('MAIL_MICROSOFT_DEVICE')).toBeNull();
    expect(s.logs.join()).not.toContain('device-secret');
  });
});
