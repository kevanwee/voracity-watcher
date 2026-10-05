# Recoverable Telegram delivery (H2)

Protocol 2 replaces destructive `take` with `claim`, `renew` and `ack`. This code
must be installed on both runners and the Apps Script web app. Merging the runner
alone does not upgrade the deployed relay. No new service, dependency or billing
is needed. H1 confirmation transactions remain the mutation boundary.

## Contract

1. The webhook validates and reduces a Telegram update to the fields Ica uses.
   Its `update_id` is the stable delivery ID. Payload chunks are written first;
   the `U_<id>` record is the acceptance marker, written last under a script lock.
   Repeated webhooks leave an existing record, lease and original timestamp alone.
2. A runner claims **one** delivery at a time under the same lock. The response
   carries a random token, runner identity and a two-minute lease. Losing the
   response or crashing does not remove the delivery. After expiry it can be
   claimed with a new token. The old token cannot acknowledge or renew it.
3. During handling, renewal runs every 30 seconds. This also refreshes PC presence;
   a long model call does not make the PC appear asleep. Idle PC polling is every
   15 seconds; cloud claims defer to PC presence for 90 seconds. The relay enforces
   ownership even if the runner's earlier status check was stale.
4. Captures and edit proposals use an owner-scoped Firestore replay ledger at
   `users/{uid}/assistant/deliveries`. The ledger and H1 inbox insertion commit in
   one transaction. Concurrent processing of the same update returns the winning
   original proposal IDs, arguments, date, buttons and accompanying model answer.
   A changed message under the same identity is refused. Later confirmation or
   cancellation never makes a redelivery insert that proposal again.
5. The runner sends the response after durable proposal storage. Only successful
   handling and a still-valid lease lead to `ack`. Acknowledgment commits a terminal
   record before deleting payload chunks. Repeated acknowledgment is harmless.
   A failed notification leaves the request retryable. An already-applied Telegram
   message edit is treated as success; other API errors remain failures.

Acknowledgment means the handler finished and Telegram accepted its response; it
does **not** mean the owner confirmed the proposed change. H1 handles that later
decision. A Telegram timeout can still produce duplicate visible replies: there
is no distributed transaction with Telegram. Those replies carry the same buttons
and cannot create another note/bookmark from the same operation. Read-only answers
and `/check` can be recomputed after a crash. Existing watch routing and politeness
controls still apply. This is not exactly-once delivery for every external effect.

Renewal failure prevents acknowledgment. It cannot cancel a network operation or
model call already underway; H1 transactions and the replay ledger protect writes
if a stale handler finishes. Cancellation/budget propagation is separate H3 work.

## Bounds and failures

| Resource | Bound / behavior |
|---|---|
| Accepted pending deliveries | 64; additional work gets a terminal capacity rejection |
| All delivery records | 512, including retained successes/failures; never evict unexpired records to admit new work |
| Normalized update | 24,000 UTF-8 bytes; larger inputs get a terminal rejection |
| Payload chunks | 1,500 Unicode code points, at most 6 KB each; no split surrogate pairs |
| Admission storage check | 300,000 bytes across existing script properties plus payload and headroom; remaining space reserved for lease/terminal metadata |
| Delivery lifetime | 24 hours from admission; an active lease is allowed to finish |
| Processing attempts | Five claims, then an explicit failure notice; no fresh mutation attempt |
| Failure notice attempts | Five; if Telegram remains unavailable, the failure stays visible in health status |
| Terminal retention | Seven days from completion/failure; pruned on activity |
| Firestore capture ledger | 128 entries within seven days, at most 700,000 serialized UTF-8 bytes; full ledger refuses new captures without evicting retry identities |

Accepted messages are not silently discarded for new arrivals. Capacity, oversized
input, malformed records, expiry and exhausted attempts have distinct terminal
states. Failure notices go only to configured owner chats and contain no message
body. An unrouteable malformed record produces a generic owner notice. `/status`
includes pending/failed counts and any admission/dispatch fault.

When the entire record budget is full, admission is **rejected**, with a bounded
count-only `RELAY_FAULT` record instead of another delivery. Apps Script's HTML
response is still HTTP 200; its response body does not make Telegram retry.
This is explicit rejection, not durable acceptance. If `/status` itself cannot be
admitted, run **relayHealth** in the private Apps Script editor to inspect counts
and fault reason without printing keys or content. Investigate capacity, preserve
pending work, and resend rejected requests after space is available. Fault counts
remain until the owner clears `RELAY_FAULT` in Script properties after diagnosis.
If Google refuses even the fault write because its quota is exhausted, only its
execution failure is available; this design cannot guarantee delivery through a
platform outage. The normal wake timer remains the fallback after a failed GitHub
dispatch; admission is not undone by that failure.

Bounds use Google's published limits: 9 KB per property, 500 KB per property store,
and 50,000 daily property reads/writes for consumer accounts. Polling every 15
seconds means at most about 5,760 idle polls/day, each with several property
operations; messages, maintenance and the shared wake script add usage. Monitor
actual usage rather than assuming quota headroom. Limits can change.
[Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).

Only Ica's supported fields are retained from Telegram updates. The private
Firestore ledger stores captured text and an accompanying answer for replay;
it is not a permanent audit archive and browser access is denied by Voracity's
existing rules. Deduplication is bounded to the retention window, not perpetual.
Telegram itself retains undelivered updates for at most 24 hours.
[Telegram update delivery](https://core.telegram.org/bots/api#getting-updates).

## Rollout (coordinated; not performed by adding this file)

1. Verify H1 is installed. Stop the PC listener (including its Node child), pause
   cloud dispatches, and let active cloud handlers finish. Keep the webhook and
   existing properties intact so incoming messages remain queued.
2. Merge/update both runner checkouts to H2, but keep them stopped. Preserve the
   PC's secret store and owner mapping. No Firestore rules deployment is required.
3. In the existing Apps Script project, replace `relay.gs`, save and deploy a **new
   version of the existing web-app deployment**. This retains its `/exec` URL and
   key. Do not rerun `connectTelegram` or use `drop_pending_updates` for this upgrade.
   Keep `wake.gs` and its timer. Run `relayHealth`; expect `protocol: 2`.
4. Legacy `U_` entries are imported under the script lock, keeping their original
   admission time. Payload chunks are committed before replacing the legacy
   record. If migration cannot complete, the original record remains; free unrelated
   capacity or investigate the private execution error before retrying.
5. Restart the PC listener and resume cloud dispatches. Check a synthetic capture,
   repeated confirmation, PC-off capture and `/status`. Confirm the cloud workflow
   runs the merged H2 commit. Do not put secret-bearing URLs or console output in a PR.

Mixed versions intentionally fail closed: the new runner refuses an old relay's
response; the new relay refuses `take`. Queued work is retained, but replies pause
until the upgrade is complete. This is compatible migration of queued data, not
support for running both protocols concurrently.

Prefer a forward fix for rollback. Never deploy the old destructive relay onto v2
records. Stop runners, retain the v2 relay/queue and ledger, and fix the runner or
adapter. If abandoning the relay entirely, drain or explicitly reconcile its
pending work first: `disconnectTelegram` cannot return already-accepted Apps
Script messages to Telegram. Then disable the webhook without dropping Telegram's
pending updates and remove `WATCHER_RELAY` from both runners. The direct polling
path remains tested and retains its offset when handling fails, but has no relay
dead-letter notices; a persistent failure can block later updates until Telegram's
own retention expires.

## Validation

`npm test` exercises the actual Apps Script file in a VM with controlled clock,
storage and dispatch faults, plus a runner/protocol simulator and handler tests.
Cases include lost claim responses, stale/wrong claims, competing runners, long
handling/renewal, duplicate webhooks, expiry, poison entries, full queues, Unicode
chunks, dispatch failure, protocol mismatch, notification failure and capture
replay after confirmation. `npm run typecheck` checks the runner contracts.

The emulator suite (`npm run test:integration`, see [H1 setup](confirmations.md))
also covers concurrent capture insertion, replay after confirmation, owner
isolation and rejected transactions leaving no ledger entry. Synthetic tests do
not verify Google's hosted web-app behavior, real Telegram delivery or quotas.
No live relay deployment or production-message test is part of this change.
