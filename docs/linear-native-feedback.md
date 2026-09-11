# Native Linear feedback and comment bridging

Linear sends `AgentSessionEvent.prompted` for replies inside a native agent session.
A human adding an ordinary root comment to a delegated issue produces a separate `Comment`
webhook. Supporting both is necessary: assignment to the human reviewer does not imply that
Linear will turn every comment on the issue into a session prompt.

The optional `linear.delegated_comment` trigger admits ordinary feedback using its explicit
connection, team/project scope and `from_users`. It refreshes the issue and verifies that the
current **delegate** is this connection's app user; the human assignee remains responsible for
the issue. The app itself cannot authorize its own comment. Configuring a delegated-comment
rule takes precedence over a matching legacy comment rule. Native thread replies are excluded
because their native prompted event is the input owner.

The Hub creates a native session on the comment's root with
`agentSessionCreateOnComment(input: {commentId})`. Linear only accepts root comments for this
mutation. If the triggering comment is nested, its original body and actor remain the prompt
and authority. The older root text must never replace the CEO's latest feedback.

## Legacy direct-assignment limitation

The intended CEO workflow requires a **human assignee and P Agent as delegate**. Some historical
project bundles also retain `linear.issue_assigned` filtered to P Agent as the direct assignee.
That fallback and a native `AgentSessionEvent.created` are separate inputs: if Linear emits both
for the same direct assignment, Hub can create two runs. Issue execution serialization makes
those runs execute sequentially; it does not deduplicate this historical combination. The
comment/session bridge guarantees above do not cover direct-assignment events. Keep the human
assignee/P Agent delegate invariant when activating the intended workflow; do not interpret the
fallback as protection against every possible missing or duplicate native session event.

## Delivery and recovery

The webhook inbox persists signed raw delivery evidence before HTTP acknowledgement. Hydration
and provider matching happen in the inbox worker and survive a Hub restart. A native session's
initial thought is emitted at workflow acceptance, before issue execution serialization can
delay the next execution. All Linear GraphQL and OAuth requests have a 20-second abort deadline.

`linear_comment_bridges` reserves one bridge per `(Hub organization, project, connection,
Linear organization, root comment)`. It records the first human receipt, comment, actor and
body. A short lease coordinates workers. Just before the external mutation the current
delegate/team are checked again and a compare-and-set records `creation_started_at`.

A competing `AgentSessionEvent.created` waits once the bridge creation attempt has started and
remains unbound. A reservation that never sent a mutation does not block an independent native
session. Once bound, only
the exact session ID created/recovered by that bridge is suppressed; the original comment
receipt owns the run. A genuine Linear Retry creates a different session and remains eligible.
An original nested receipt replay still routes after its thread becomes native. A delayed
comment whose timestamp predates that bridge's native session is also handled as ordinary
feedback, since it could not have produced a native prompt when posted.

Accepted native inputs carry a dispatch key scoped to connection, Linear organization, native
session and source comment/activity. Database insertion serializes competing deliveries within
the Hub project: comment-first, native-first and parallel arrivals create one run and wakeup.
Prompted activities keep their own activity IDs; a later activity or an explicit new session
is a new input. Live execution steering additionally uses the durable prompt handoff claims
described in [Linear turn continuity](linear-turn-continuity.md).

Linear's creation mutation has no client idempotency key. When its acknowledgement is lost,
Hub rereads the exact root and binds a session belonging to the expected app. If that read
cannot establish success, the durable attempt remains uncertain. Expiring the lease or
restarting Hub does **not** authorize another automatic mutation. Retries reread the root until
the session becomes visible. If it never does, an operator must inspect the original request
and native session history, then either bind the verified session or clear `creation_started_at`
only after establishing that no session was created. Scope any repair by all five key fields
and compare the observed row; never clear all pending attempts. The inbox retains the last
failure and retries the original evidence. This is recoverable delivery, not an exactly-once
network guarantee.

## Native agent outputs

`linear.reply` remains the required final output. It exposes `hub.reply` with these forms:

```json
{"content":"Le scénario est corrigé et vérifié."}
{"kind":"question","content":"Quelle présentation préfères-tu ?","options":[{"label":"Résumé","value":"summary"},{"label":"Détails","value":"details"}]}
{"kind":"auth","content":"Connecte le compte du projet pour continuer.","auth":{"url":"https://example.com/project-auth","providerName":"GitHub"}}
{"kind":"error","content":"La vérification a échoué. Je peux reprendre après rétablissement de l’accès."}
```

Question options become native `elicitation` with `signal: select` and structured `options`.
The CEO can still answer with free text. Authentication becomes native `elicitation` with
`signal: auth` and `signalMetadata: {url, providerName?, userId?}`. URLs must be HTTPS without
embedded credentials. Linear treats the auth signal as ephemeral; Hub does not add the
`ephemeral` flag, which is reserved for thought/action activity content. Hub does not fabricate
`prompt` activities on behalf of a human.

Optional `linear.progress` exposes `hub.progress({content})` and emits an ephemeral native
thought. Optional `linear.plan` exposes `hub.plan({steps})`, replacing the session's native plan
with content/status items (`pending`, `inProgress`, `completed`, `canceled`). Both tools are hidden
when no native session exists. Neither satisfies required `linear.reply`, consumes its reply
quota, nor makes an unanswered input complete. Progress/plan tool calls are excluded from the
automatic tool mirror to avoid duplicate activity noise. Adding the Paseo session URL uses
`addedExternalUrls`, preserving other session links.

The project must obtain any connection link through its own scoped Composio/session identity;
an auth elicitation displays a link and does not itself grant access or resume a Hub execution.

## Verification and primary contract

```sh
bunx vitest run src/triggers/linear/provider.delegated.test.ts src/db/linear-dispatch.test.ts
bunx vitest run src/db/linear-dispatch.integration.test.ts
bunx vitest run src/triggers/linear/reply.test.ts src/providers/linear/client.test.ts src/provider-applications/internal/runtime-owner.test.ts src/providers/linear/registration.test.ts
```

The provider fixture reproduces the sanitized SEN-84 failure (new CEO root comment, current
app delegation, separate human assignee). It covers nested feedback, native-first delivery,
concurrent creation, lost acknowledgement, revoked delegation, parser rejection and delayed
ordinary comments. PostgreSQL tests cover concurrent dispatch insertion, bridge leases and
state surviving reconnection. Inbox and daemon continuation have separate suites.

Contract checked against Linear's [agent interactions](https://linear.app/developers/agent-interaction),
[signals](https://linear.app/developers/agent-signals), [agent best practices](https://linear.app/developers/agent-best-practices)
and [current SDK GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
on 2026-09-09. Public Paseo documentation lives in the Paseo repository and needs the companion
change before release.
