# Ica execution contracts and local model settings (H3)

H3 builds on H2 delivery/replay and H1 confirmation transactions. It does not
change the browser's independent model setting or deploy the relay.

## Tool boundary

`agent-contracts.ts` validates every model tool call before lookup or proposal:
known name, plain object, allowed/required keys, exact string types, field limits,
valid enum values and real calendar dates. JSON parse failure is an error, never
an empty object. Calendar ranges must be ordered and at most 62 days apart;
explicit reminder ranges are limited to 366 days. `when` cannot accompany a range.
Card references accept exactly one `card` or legacy `id`, never both. The emitted
schemas disallow additional properties. Invalid calls return fixed, useful errors
to the model within the same run budget so it can correct them.

New proposals also pass H1's `validateAction`; approval/execution validates them
again. Runtime checks reject malformed stored cards/bookmarks, and `ai:false`
cards are excluded from model context. No tool in this loop writes to Firestore.
Trace data contains tool names or fixed error labels, not arguments or private
source content. Existing owner/chat checks and card revisions remain enforced.

Non-streaming Ollama replies must have `done: true`, an assistant message, valid
content/call types and a supported completion reason. Output-limit responses are
rejected before any calls are used. This checks the envelope described by the
[Ollama chat API](https://docs.ollama.com/api/chat); it is not a guarantee of factual
accuracy or of a model following tool instructions.

## Run policy

`agent-policy.ts` is the single question-run limit definition:

| Limit | Value |
|---|---|
| Model rounds / total calls | 4 / 8 (invalid calls count too) |
| Question | 4,000 characters; oversized input is rejected, not silently cut |
| Deadline | 180 seconds, including initial card read, model calls and tool reads |
| Serialized request | 24,000 UTF-8 bytes, including model options, schemas and all context/history |
| Cumulative serialized requests | 72,000 UTF-8 bytes across the run |
| Model response | 64,000 bytes, enforced while streaming the HTTP body into memory |
| Tool result | 6,000 bytes; oversized arrays return items/total/shown/truncated metadata as valid JSON |
| Initial card collection | 2,000 records; larger collections require a narrower retrieval implementation |
| Ollama output/context settings | 1,024 output tokens / 8,192 context tokens |

The byte limits are deterministic bounds, not an exact tokenizer. Results include
`status`, input/response bytes, rounds and tool-call count. Terminal reasons cover
completion, invalid input/response/results, output/input limits, deadline,
cancellation, tool/round exhaustion and model availability. On any terminal
failure, all partial proposals are discarded. Only a complete result can reach
H2 proposal storage. No partial action is committed by the model loop.

One AbortSignal reaches model and Calendar requests. All asynchronous reads race
the deadline, including SDK reads without cancellation support. Checks after each
await prevent late results from appending proposals. HTTP redirects from the model
endpoint are refused so a localhost redirect cannot forward private prompts.
Calendar fetch failures are reported as incomplete coverage, not an empty calendar.

Limitations: Firestore reads already submitted may still complete and count toward
quota; JavaScript cannot preempt synchronous iCal parsing; cancellation cannot
undo an already-submitted H1/H2 transaction. Listener setup/settings reads, Telegram
delivery and the scheduled watcher are separate from this question-run deadline.
Listing translation uses the same model configuration but retains its separate
existing batch/time policy. No automatic cloud model fallback is introduced.

## PC configuration

The browser saves Ollama settings in browser storage. Ica no longer reads the
obsolete `users/{uid}/settings/brain` model fields. All mapped owners on this PC
use the PC's configured model for both questions and listing translation.

Precedence is per field: explicit process environment (`WATCHER_OLLAMA_URL`,
`WATCHER_OLLAMA_MODEL`), then `ollama.url`/`ollama.model` in the existing private
`%USERPROFILE%\.voracity-watcher\config.json`, then the legacy defaults
`http://localhost:11434` and `qwen3:14b`. The local PowerShell launchers apply the
file settings; direct Node invocations use environment/defaults. Nothing uploads
this configuration to Firestore. Invalid explicit values fail with a fixed setup
error rather than silently selecting a different model.

After H3 is merged and the main PC checkout updated, configure it without
re-entering any credentials:

```powershell
.\scripts\local\install.ps1 -OllamaModel 'qwen3:14b' -OllamaUrl 'http://localhost:11434'
.\scripts\local\install.ps1 -ShowModel
```

Use the exact installed model name you want. The setter preserves `repo`, `node`
and unrelated config fields, validates before writing, and saves a replacement
file. Both commands work with an already-installed watcher; model settings are a
separate update from initial credential installation. Restart the listener after
saving. `/status` on the PC also shows its effective model and loopback endpoint.
Cloud `/status` does not pretend to have a local model. The private listener startup
log prints the same diagnostic; public scheduled runs do not print it.

Endpoints must be HTTP(S) loopback origins (`localhost`, `127.0.0.1`, `[::1]`),
without userinfo, path, query or fragment. Only an origin and a bounded model name
are accepted. A remote Ollama endpoint is not a migration option.

Before rollout, users who relied on a custom legacy Firestore model must set that
model explicitly. Defaults remain unchanged for everyone else. Updating settings
does not download a model or start Ollama. To revert settings, run the same command
with the prior URL/model and restart. Preserve config backups privately. To roll
back code, keep the deployed relay/runner on a compatible H2 protocol; reverting
H3 is not permission to restore destructive relay `take`.

## Validation and live check

Unit tests cover schema/date failures, invalid JSON and response envelopes,
output-limit tool calls, streaming response bounds, cumulative input accounting,
invalid evidence, cancellation/deadline on slow reads and model calls, discarded
partial proposals, endpoint confinement and configuration precedence. A PowerShell
test uses a temporary synthetic config, checks preservation/precedence/rejection,
and cleans up only its own files. CI runs both plus H1/H2 emulator tests.

The live test is opt-in and supplies only synthetic cards and text:

```powershell
$env:WATCHER_LIVE_OLLAMA = 'true'
npx vitest run test/agent-live.test.ts
Remove-Item Env:WATCHER_LIVE_OLLAMA
```

It requires an already-installed local model; it never contacts production
Firestore or Telegram. On 5 October 2026 it passed against local `qwen3:14b`
in about 13 seconds. This verifies one real tool-use path, not broad legal accuracy.
