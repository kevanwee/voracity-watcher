# Durable confirmations (H1)

Implemented on the H1 feature branch, 5 October 2026. Deployment is separate.

`confirmations.ts` defines closed proposal schemas and the confirmation lifecycle.
`confirmation-store.ts` supplies the Firestore transaction adapter. Telegram is
only an input/output adapter; it cannot perform captures outside that boundary.

For a confirmed action, one transaction reads the owner's pending proposal and
target revision, applies the change, consumes that proposal and its stored sibling
choices, and records the outcome. New objects have a deterministic owner/proposal/
argument-derived ID. If a commit response or subsequent Telegram notification is
lost, replay returns the outcome and does not create another object. Failed
transactions leave both the target and proposal unchanged. This follows Firestore's
[transaction semantics](https://firebase.google.com/docs/firestore/manage-data/transactions).

## Binding and validation

- New proposals are version 1 envelopes, with validated action, creation time,
  sibling group and SHA-256 digest bound to owner and proposal ID.
- Telegram callbacks carry action, proposal ID and a 128-bit prefix of that digest,
  within the 64-byte callback limit. The chat must still match `WATCHER_OWNERS`.
  The digest binds displayed arguments; it is not a substitute for authentication.
- Only `save` and `cancel` are accepted. Group membership comes from the stored
  envelope, never user-supplied sibling IDs. Edits to a stored proposal invalidate
  its original callback. Invalid fields and impossible calendar dates are rejected
  before offering and again before execution. Admin SDK writes bypass client rules,
  so these checks must not be removed.
- Existing-card changes retain revision checks. The briefing's direct `done` button
  remains a desired-state operation with exact target/revision and reminder-kind
  checks; reopening a reminder invalidates the old revision.
- Save/cancel races resolve to whichever transaction commits first. Later attempts
  report that stored outcome, rather than changing it.

## Storage and retention

`users/{uid}/assistant/inbox` contains `pending` and `receipts`. There is no new
collection, token, service or billing requirement. Client rules already deny this
path; it is runner-only. Receipts include schema version, argument digest, timestamp,
outcome and target ID, plus the title/date needed to render the result. Captured
note bodies are omitted from receipts. This is a retry record, not a permanent audit
archive or a cryptographic tamper-proof log.

Proposals expire after 24 hours. At most 32 pending proposals are accepted. Receipts
are pruned on activity to the newest 64 within seven days; the entire inbox is capped
at 700,000 serialized UTF-8 bytes. A full inbox rejects new work without discarding
accepted pending work. Inactive records may remain until the next activity, but their
space is bounded. Evicting a receipt cannot recreate its already-consumed proposal;
late callbacks report expired. Generated target IDs add a create precondition even
if an inconsistent external recovery restores an old proposal.

## Rollout and rollback

1. Stop the old PC listener and briefly pause wake-up/message dispatches. Let
   active cloud runs finish and clear queued old-version runs before switching
   either runner. Do not run the legacy inbox writer concurrently with the new
   transaction adapter.
2. Merge/deploy the reviewed watcher change, update the PC checkout, then restart
   its listener and resume dispatches. No Apps Script code or production Firestore
   rules change is required.
3. Old pending buttons lack argument binding and deliberately ask the owner to
   resend the request. Existing cards, bookmarks and schedules are unchanged.
4. Check a synthetic capture, confirmation retry and existing-card edit through
   Telegram after deployment. No live Telegram validation was performed during H1.
5. Prefer a forward fix. If rolling back, first stop both versions and let the owner
   handle/resend pending requests after the switch. Preserve the inbox/receipts for
   diagnosis; do not restore consumed proposals or promise old buttons will work.

Deployment and merging belong to the owner. These instructions do not deploy it.

## Tests

`npm test` covers policy/handler behavior, including unknown callbacks, validation,
expiry, rejection, bounds and Telegram notification failure. Emulator-only cases
are skipped in that command unless the emulator environment is set.

`npm run test:integration` requires a loopback emulator and fails without its
environment variable. To start the pinned CLI and synthetic demo project:

```sh
npx --yes firebase-tools@15.31.0 emulators:exec --config test/firestore-emulator.json --project demo-ica-confirmations --only firestore "npm run test:integration"
```

CI runs that command with Java 21. Tests prove transaction contention, concurrent
offers, save/cancel choices, revision conflicts and rollback on failed target
creation. The emulator project and fixture identities are synthetic. Its test rules
deny all client access; the transaction adapter uses Admin SDK.

An additional local check used Voracity's actual private rules and confirmed that
generated note/reminder/bookmark documents remain owner-editable, other owners are
denied, and no browser identity can read the inbox. Those private rules are not copied
into this public repository.

## Remaining work

Relay delivery still removes messages before successful handling. H2 must introduce
durable update identity and claim/lease/ack recovery. H1 does not deduplicate separate
capture messages or automatically resend a failed Telegram notification. It does not
claim exactly-once behavior across Telegram, Calendar or other external services.
