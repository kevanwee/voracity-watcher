# Ica email watcher

This opt-in companion runs in a **separate, private Google Apps Script project**.
It checks Gmail and optionally Microsoft Outlook approximately every five minutes,
then sends matching new mail through the existing Ica bot. The browser and PC can
be off. It adds no paid services, Firestore collections or browser OAuth scopes.
It is independent of the site watcher, GitHub wake timer and Telegram webhook:
installing it never changes `getUpdates`, `setWebhook`, or the existing relay.

Code is ready for installation; merging this repository does **not** activate it.
Each provider needs its own explicit account consent. A Gmail connector in ChatGPT
does not grant Gmail access to this script, Voracity or Ica.

## How this connects to Ica and Voracity

Ica is the existing Telegram bot, rather than one single running program. Voracity's
Site watcher panel saves website rules to Firestore. The GitHub/PC watcher runner
reads those rules, checks sites, sends alerts as Ica, and processes Ica's incoming
commands through the existing Telegram relay/listener.

This mail companion is another alert producer using **the same bot token and
private chat ID**. Its rules, authorization and checkpoints stay in your private
Apps Script project. No new bot, BotFather command or Telegram webhook is needed.
These PRs add neither an Email watcher panel in Voracity nor `/email` commands;
the existing `/check` and `/status` commands still refer to site watches. Email
settings and health are managed in the private script editor. Keeping this script
separate avoids giving the public-facing relay mailbox permissions or credentials.

## Match rules

Default rules are OR conditions, case insensitive:

- Whole word `masters` in the subject or body.
- Whole word `llm` in the subject or body.
- Phrase `master of laws` in the subject or body, with flexible whitespace.
- Exact From address `llm.admissions@smu.edu.sg`.
- Exact From address `masters.admissions@smu.edu.sg`.

Display names do not affect sender matching; a different domain or address suffix
does not qualify. Sender matching is not a verification of a sender's identity.
`webmasters`, `masterson`, `llms` and `master of lawschool` do not match. An email
discussing a large language model **does** match `llm`. HTML text is decoded without
executing it. Attachments are excluded. Read and unread mail both qualify; reading
a message does not suppress its alert. New replies are considered individually.
Gmail excludes sent, draft, spam and trash messages; Outlook excludes Sent Items,
Drafts, Junk Email and Deleted Items, while including custom folders.

To change rules, add the private Script property `MAIL_RULES`:

```json
{"words":["masters","llm"],"phrases":["master of laws"],"senders":["llm.admissions@smu.edu.sg","masters.admissions@smu.edu.sg"]}
```

Changes apply to subsequent checks; they do not trigger a historical backfill.

## Install Gmail first

1. Sign in to [Google Apps Script](https://script.google.com/) as the intended Gmail
   account. Create a new private project named **Ica email watcher**. Do not share it
   or deploy it as a web app. Do not add this code to the existing public relay.
2. Copy `scripts/apps-script/mail/mail.gs` into the editor's `Code.gs`. Enable
   **Show appsscript.json manifest file in editor** in Project Settings and replace
   the manifest with `scripts/apps-script/mail/appsscript.json`. It declares the
   Gmail API advanced service and only Google read-mail, external-request and
   trigger-management scopes. With a default Cloud project, adding the Gmail service
   enables its API automatically. If using an existing standard Cloud project,
   enable the Gmail API there without enabling billing.
3. In **Project Settings → Script properties**, add these private values:

   | Property | Value |
   |---|---|
   | `MAIL_GMAIL_ACCOUNT` | The full Gmail address signed in above |
   | `TELEGRAM_BOT_TOKEN` | Ica's existing bot token, from your private setup |
   | `MAIL_CHAT_ID` | Your existing Ica **private** chat's positive numeric ID |

   Do not paste tokens into chat, Git, a PR, screenshots or terminal output. This
   script only sends to the configured chat; it never changes Ica's incoming routing.
4. Select and run **installMailWatcher**, then review and grant its Google permissions.
   It verifies the Gmail address and records the current history cursor. Old mail is
   not sent. Reinstalling retains the existing cursor and does not add another timer.
5. Optionally run **previewGmailMatches** to find existing candidates from the last
   30 days (up to 50 candidates). It logs matching subjects, senders and links **in
   this private editor only**, sends no Telegram messages and changes no read flags
   or delivery checkpoints. Do not copy those logs to the public repository.
6. Run **testMailNotification** for an explicit, content-free Ica test. Run
   **checkMail** manually once, then **mailHealth**. Check that Gmail has a completed
   timestamp and no fault. Future runs come from the five-minute trigger.

For multiple Gmail accounts, install a separate private project under each account.
Never substitute a Google app shortcut selection for mailbox authorization.

## Connect school-managed Outlook directly

School policy may prevent app registration, user consent, device sign-in, or access
from Apps Script. Do not attempt to bypass those controls. If consent requires an
administrator, give the school the requested permissions and purpose and wait for
approval. This code cannot establish what a particular school's policies allow.

1. In [Microsoft Entra app registrations](https://entra.microsoft.com/), register an
   app for your school tenant (or ask the administrator). A single-tenant school app
   is sufficient. Enable **Allow public client flows** under Authentication. No client
   secret, paid service, background application permission or redirect URI is needed.
2. Add **delegated** Microsoft Graph permissions `Mail.Read` and `User.Read`.
   `offline_access` allows connection renewal. `Mail.Read` reads bodies for matching;
   `User.Read` verifies the account selected during consent. There are no send,
   modify or delete permissions. Obtain administrator consent if school policy
   requires it.
3. Add these private Script properties:

   | Property | Value |
   |---|---|
   | `MAIL_OUTLOOK_ACCOUNT` | The intended full Outlook/school mailbox address |
   | `MAIL_MICROSOFT_CLIENT_ID` | Application (client) ID from registration |
   | `MAIL_MICROSOFT_TENANT` | School directory (tenant) ID; default is `organizations` |

4. Run **beginOutlookConnection** only when ready to sign in. Open the Microsoft
   device sign-in URL shown in the private editor and enter its temporary code.
   Sign in with the intended school account and review the requested permissions.
   No password is entered in Apps Script or chat.
5. After finishing consent, run **finishOutlookConnection**. It verifies the mailbox
   address before storing Microsoft tokens in this private project's Script properties.
   If it reports `microsoft_auth_http_400`, consent may still be pending or rejected;
   wait at least 30 seconds before retrying. Expired codes require starting again.
   A school policy rejection requires school approval, not repeated sign-in attempts.
6. Run **installMailWatcher** again. Outlook's baseline starts at connection time;
   Gmail's existing baseline is preserved. Run **checkMail** and **mailHealth** to
   verify both mailboxes. A revoked Microsoft connection does not stop Gmail checks.

Microsoft refresh tokens are rotated on renewal and are never logged or sent to
GitHub, Firestore, the browser or the Telegram relay. Google manages its own grant;
the script obtains an ephemeral Google access token at execution and never stores
or exports Google access/refresh tokens. Project editors can read Script properties,
so keep the project private. Revocation can still require signing in again.

## School-approved forwarding alternative

If direct Graph consent is unavailable, and the school **permits external
forwarding**, use Outlook on the web's server-side rules to forward or redirect
matching mail into the watched Gmail account. Preserve the school mailbox's copy.
Use separate OR rules for words/phrase in subject or body and for the two senders;
placing different condition types in one rule can accidentally require both.
Do not restrict to unread messages. A redirect preserves the original sender best;
a forward may rely on matching the quoted subject/body. Validate a real delivered
copy in Gmail before treating the school mailbox as monitored.

Forwarding is an alternative to direct Graph monitoring; do not enable both unless
you accept separate alerts for the same mail delivered to two mailboxes. This
script deduplicates by provider message ID, not cross-account content. If the school
blocks forwarding too, school approval is needed; no forwarding rule or scraping
workaround is created by this code.

## Delivery, bounds and recovery

- Each alert begins `Doot Doot.` and contains the mailbox type, subject, sender,
  received timestamp and an open-mail link. **The full body is not sent to Telegram**,
  stored in script properties, fed to AI, or published in Actions logs.
- Gmail uses `historyTypes=messageAdded` with a persistent history cursor and page
  token. Outlook uses all-mailbox received-time snapshots, immutable message IDs,
  pagination and a ten-minute overlap for delayed indexing. Delays beyond that
  overlap, imported mail with old received timestamps, or mail removed before a
  check can be missed. This is polling, not guaranteed instant delivery.
- A stable SHA-256 message identity is recorded only after Telegram accepts an
  alert. Failed sends preserve the provider checkpoint and retry later. A timeout
  after acceptance, or a crash before the receipt write, can duplicate an alert;
  there is no exactly-once transaction with Telegram.
- At most three pages per mailbox per run, 25 provider records per page, with a
  110-second mailbox budget and four-minute total budget. Unfinished page tokens
  remain for later runs. Gmail also checkpoints its position within history records,
  so even large nonmatching batches resume without repeatedly reading the same mail.
- At most 1,500 alert receipts across both providers. Gmail receipts are pruned
  after seven days on a completed scan; Outlook retains the overlap plus one day.
  Unfinished scans never prune their receipts. Capacity is an explicit fault,
  never silent eviction of replay protection. Investigate backlog before removing
  receipts; removing them can repeat alerts. State/token properties are capped at
  8 KB each, below Google's 9 KB property limit. Large MIME bodies requiring separate
  downloads stop with `gmail_body_requires_download` instead of claiming a full match
  check. Attachment contents are never inspected.
- Provider and Telegram failures back off at least five minutes and honour HTTP
  `Retry-After`. Telegram backoff is shared across this script's Gmail, Outlook and
  manual test sends. Fault notices are content-free and sent once per current fault;
  Telegram failures are not immediately retried just to send a failure notice.
  `mailHealth` exposes fixed fault codes, completion timestamps and backlog state.
- `gmail_http_404` for history means the saved cursor may have expired. It is
  deliberately **not** automatically reset: that would silently skip mail. Stop
  the watcher, inspect the missed date range manually, then, only if you accept a
  fresh baseline, remove `MAIL_STATE_gmail` and run `installMailWatcher`. Old mail
  will not be backfilled. Other faults may require renewing consent or enabling
  the API. Do not expose raw provider responses while diagnosing.
- **stopMailWatcher** removes only this project's `checkMail` triggers and preserves
  checkpoints for resuming. **disconnectOutlook** removes its account setting and
  locally stored Microsoft tokens; also revoke app consent in Microsoft account
  settings. To remove Gmail access, revoke the script's grant in your Google account.
  Deleting this private project removes its configuration and delivery receipts.

Apps Script, Gmail, Graph and Telegram quotas and policies still apply and can
change. No billing is enabled. Google's trigger timing is approximate; check its
execution history and failure emails when diagnosing a stale watcher.

## Validation

`npm test -- test/mail-script.test.ts` executes the **actual Apps Script source** in
a VM with synthetic provider services: matching, MIME text, account binding,
installation, pagination, retry receipts, backoff, expired history, capacity,
Microsoft token rotation and off-host nextLink rejection. `npm run typecheck` and
the full runner suite verify integration. These tests do not prove live mailbox
consent, school policy, Google quotas or Telegram delivery. Verify those after
installation using the content-free test and a new matching email.

Official references checked 19 October 2026:

- [Gmail history and cursor expiry](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)
- [Gmail read-only API access](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Microsoft device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft Graph message paging](https://learn.microsoft.com/en-us/graph/api/user-list-messages)
- [School/organization forwarding controls](https://learn.microsoft.com/microsoft-365/security/office-365-security/outbound-spam-policies-external-email-forwarding)
