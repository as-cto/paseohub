# Durable Linear final reports

`filters.publish_issue_comment: true` opts a Linear trigger into a durable final-report contract.
The default reply behavior is unchanged. Opted-in `hub.reply` reserves one immutable report per
execution input and two random UUID v4 IDs before any provider request. It publishes the full
report as an ordinary **root issue comment**, then as the native response or elicitation. Root
comments remain accessible to integrations that do not read native agent activities.

The `linear_reply_deliveries` journal stores both destinations and their acknowledgements.
Only the canonical attempt counts as the required reply. Tool retries and background recovery
reuse its IDs, including after an expired or failed tool attempt. A duplicate-ID error alone is
not delivery proof: recovery reads the exact ID and verifies its target and content. An accepted
mutation with a lost acknowledgement therefore does not require another model run. UUID identity
prevents a retry from creating a second object; provider availability and read permission are
still required to establish delivery.

The authorized event snapshot binds each report to its original connection, organization, and
issue before its first reservation. Replacing a connection cannot authorize an old execution to
publish using the new installation; recovery and native handoff enforce the same boundary.
The reserved connection ID is also checked when selecting credentials and during locked token
refresh, so a replacement between the reporting guard and an API request is refused.

The provider source sweeps pending reports at startup and every 15 seconds, in batches of 20,
with persistent retry delays and leases. It also finds opted-in terminal executions that have no
report, covering a crash before the terminal hook. Their deterministic notice states that work
and verification are unconfirmed; it never infers completed work from progress narration or
restarts an interrupted, failed, or blocked model. Reporting does not change a failed execution
into a successful one.

Output reservation and native publication share `execution.prompt:<id>` with prompt delivery.
An older report can close its own distinct native session. If the newer input uses that same
native session, recovery preserves the ordinary comment and records native supersession instead
of closing the newer turn. A session change without an earlier final report reserves a factual
handoff notice before the input boundary. Its notice claims neither work completion nor a product
outcome. The newer input still owes its own report.

## Optional issue finalization

`hub.reply` accepts `outcome` with `kind`, `validation`, `nextAction`, and optional `assigneeId`.
The validation and next action appear in both destinations. An outcome alone grants no mutation
authority. `filters.finalize_issue` additionally requires the existing scoped connection/team,
actor restrictions, `require_delegate: true`, and `publish_issue_comment: true`:

```yaml
finalize_issue:
  team_id: <Linear team ID>
  review_state_id: <state ID in this team>
  completed_state_id: <completed state ID in this team>
  waiting_state_id: <optional nonterminal state ID>
  allowed_assignee_ids: [<explicitly permitted human ID>]
```

`ready_for_review` selects the configured review state; `completed` selects the completed state.
`needs_input`, `blocked`, and `interrupted` select the optional waiting state. `no_action` leaves
metadata alone. Without an explicit assignee the existing owner is preserved. An explicit person
must be allowlisted and an active human member of the configured team. Delegation is never cleared.
A completed, canceled, or duplicate issue is preserved. The handler checks live team, delegation, workflow
state type, and input identity; it never guesses translated state names.

`linear_issue_finalizations` records the planned target and whether a mutation was attempted.
Finalization runs after both report destinations are confirmed and before the reply is
acknowledged. Read-back confirms the intended metadata. A failed or ambiguous action does not
become a successful output: its report remains unacknowledged and the action is recorded for human
review. Refused or ambiguous actions are excluded from automatic recovery. Their already-published
reports are not replaced, and no metadata mutation is replayed automatically.

Linear issue updates have no compare-and-set precondition. The final read and the mutation cannot
be atomic with a human edit. Hub minimizes that interval, preserves observed human changes, and
refuses to repeat an attempted update when its outcome is uncertain. It cannot promise exclusion
of a simultaneous external edit. Configure this feature only after verifying the actual team,
state IDs, and permitted humans for each route.

## Verification

Focused tests are `reporting.test.ts`, `native-handoff` scenarios within that suite,
`finalization.test.ts`, `client.publication.test.ts`, `client.finalization.test.ts`, the output
boundary tests in `execution-capabilities/server.test.ts`, and
`db/linear-replies.integration.test.ts`. The last test uses a temporary embedded database and
reopens it to verify durable checkpoints; it does not connect to a deployment.
