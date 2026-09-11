# Linear input turns and issue execution ownership

A native Linear session may keep one execution alive between messages. Its completion token
belongs to that execution and remains usable only while the execution is live. A new execution
always receives its own token. Keeping a conversation alive does not extend its hard deadline.

Production webhook registration uses `linear_webhook_inbox` (migration 0047). After signature and
timestamp verification, the raw payload, event header and original application configuration
version are persisted before HTTP 200. No Linear API or trigger-handler network call sits on this
acknowledgement path. Database admission failure returns HTTP 503 so Linear can retry. Delivery
and signature constraints prevent duplicates even when the same signed payload gets another
delivery ID. Signature verification is not repeated for already admitted work after restart.

The source worker drains pending rows at startup, on admission and every second. It holds a
database lock per inbox row through hydration, route acceptance and trigger-handler completion.
One handoff runs at a time per database instance, shared by overlapping source versions and
applications. Waiting handoffs queue before acquiring an advisory connection; nested provider and
daemon queries therefore retain pool capacity. Small batches run sequentially without a timer gap
between their rows. This deliberately trades processing latency for bounded database occupancy:
a slow Linear request (up to its 20-second HTTP timeout) or a backlog can delay later session
activity. HTTP admission remains independent; this is not a promise of a ten-second activity
response under backlog. Errors retain the row with a diagnostic and exponential retry delay from one second
to one minute. A process crash releases the lock and leaves the row pending. A row is complete
only after handler success, including a durable rejection; existing receipt, bridge, run and input
deduplication protect reprocessing if the last database acknowledgement was lost. Rows belong
to their Linear application ID, and another application cannot drain them. Connection and user
authorization are still evaluated by the existing route and trigger filters during processing.

`finish_execution` acknowledges the current input without clearing output evidence. The lifetime
`outputEmissions` count is used for accounting and terminal notifications. Current-turn required
outputs and limits are computed from delivery attempts stamped with the current turn ID. The
turn ID and input timestamp live in the existing `hub_action_acknowledgements` JSON field and
survive Hub restart. The initial turn has no ID for compatibility with existing executions.

Before sending a follow-up to the daemon, Hub records a new input boundary and clears the old
finish acknowledgement. A response whose delivery started on the previous turn cannot satisfy
the new input even if Linear accepts it later. Completion is checked again after stream handling,
and its acknowledgement compares the expected turn ID atomically. A later unanswered message
therefore cannot expire successfully because an earlier message was answered.

Prompt handoffs use a database advisory lock per execution as well as local ordering, matching
the daemon's prompt ordering across Hub workers. Native Linear inputs provide an identity based
on the session and activity, independent of the webhook delivery ID. Hub hashes that identity and
records a pending input claim before sending it. A confirmed acknowledgement changes it to
delivered; subsequent deliveries are no-ops, including after execution completion or Hub restart.
An explicit daemon `delivered: false` releases the claim so the normal fallback can proceed.
The initiating run uses the same canonical input key. If a message first starts a new execution,
its later webhook replay cannot steer that initial prompt into the execution again. This is
checked historically and again under the execution lock before sending any prompt.

This is not an exactly-once network protocol: the daemon prompt RPC has no persisted message
identifier, so a lost acknowledgement cannot prove whether the message was delivered. The pending
claim then throws `DaemonPromptDeliveryUncertainError`, preventing an automatic second prompt or
fallback execution. The webhook receipt remains retryable. An operator must inspect the daemon
timeline before marking that claim delivered, or clearing it if the input was never received, then
replay the receipt. Pending uncertainty is retained even after execution completion. Neither a
Hub restart nor a timeout constitutes proof of non-delivery. Input receipts remain the durable
source for investigation/replay.

Independent Linear sessions and comment runs can refer to the same issue. Their executions are
serialized at database insertion by `(project, connection, Linear organization, issue UUID)`;
session IDs, thread IDs, display identifiers and configuration revisions do not divide that
ownership. A second run retains a durable wakeup and retries after one second. It does not reserve
an execution or spend a usage unit while waiting. Other issues remain independent. Ownership
lasts through the prior execution's terminal state until its daemon stop/archive is acknowledged.
The existing workflow deadline still bounds waiting, and a live conversation may hold ownership
until its configured idle deadline.

Only normalized Linear contexts carrying an explicit connection identity participate. Existing
non-Linear workflows keep their scheduling behavior. This is execution serialization, not an
authorization grant; trigger filters still decide who can start or continue the work.

The `branch-off` path reuses the issue's worktree on disk. Set `worktree.reuseWorkspace: true`
with a supporting daemon to also reuse its Paseo workspace identity across executions. Retaining
that workspace requires `auto_archive: false` on the workflow; `paseo.work.id` alone does not make
an archived worktree permanent. Every execution still receives its own completion token and agent,
while the native session can keep that agent alive between its input turns.

Focused verification:

```sh
bunx vitest run src/daemons/conversation-turn.test.ts src/db/linear-issue-serialization.test.ts src/execution-capabilities/required-outputs.test.ts src/triggers/linear/mirror.test.ts
bunx vitest run src/triggers/linear/webhook.test.ts src/providers/linear/registration.test.ts
bunx vitest run src/db/agent-executions.integration.test.ts
```

The integration suite checks real PostgreSQL persistence and reconnect behavior. Public Hub
documentation is maintained in the Paseo repository and needs the companion documentation change
before release.
