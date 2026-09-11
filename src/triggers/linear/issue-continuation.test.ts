import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/compiler.js";
import type { LaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import type { TriggerProviderExecutionControl } from "../../providers/registration.js";
import type { LinearOutputContext, LinearTriggerContext } from "./provider.js";
import { canContinueIssueWork, continueLinearIssue } from "./issue-continuation.js";

const configuration = compileHubConfig({
  environments: [{ name: "issue", kind: "daemon", daemon: "runner", cwd: "/repo" }],
  triggers: ["linear.agent_session", "linear.delegated_issue_updated"].map((on, index) => ({
    name: `route-${index}`,
    on,
    max_runtime: "1h",
    filters: {
      connection: "linear",
      team: "team",
      from_users: ["human"],
      require_delegate: true,
      continue_issue: true,
    },
    steps: [
      {
        id: "work",
        environment: "issue",
        max_runtime: "1h",
        idle_timeout: "5m",
        agent: { provider: "codex" },
        prompt: [{ text: "Handle the supplied Linear event" }],
      },
    ],
  })),
});
const trigger = configuration.triggers[1]!;
const intent: LaunchMachineIntent = {
  kind: "launch_machine",
  organizationId: "org",
  projectId: "project",
  triggerRunId: "run",
  triggerName: "route-0",
  environmentName: "issue",
  environment: { kind: "daemon", daemonId: "daemon", authoredSlug: "runner", cwd: "/repo" },
  prompt: "Initial task",
  agent: { provider: "codex", mode: "default" },
  autoArchive: true,
  configurationRevisionId: "revision",
  hubConfig: configuration,
  allowOutputs: [],
  triggerContext: null,
  outputContext: null,
};
const target: LinearOutputContext = {
  provider: "linear",
  linearOrganizationId: "linear-org",
  issueId: "issue-uuid",
  agentSessionId: "new-session",
  threadRootCommentId: null,
  turnKey: "event-key",
};
const triggerContext: LinearTriggerContext = {
  provider: "linear",
  target,
  event: {
    linear: {
      event_type: "issue",
      action: "update",
      delivery_id: "delivery",
      connection_id: "connection",
      organization: { id: "linear-org" },
      actor: { id: "human" },
      issue: {
        id: "issue-uuid",
        title: "Task",
        description: null,
        project: null,
        team: { id: "team" },
        state: null,
        assignee: null,
        label_ids: [],
      },
      comment: null,
      agent_session: { id: "new-session", app_user_id: "agent", status: "active" },
      agent_activity: null,
      prompt_context: null,
      trigger_thread_context: { status: "unavailable" },
    },
  },
};
function input(promptActive: TriggerProviderExecutionControl["promptActive"]) {
  return {
    executions: { promptActive, stopActive: async () => ({ stopped: 0 }) },
    projectId: "project",
    revisionId: "revision",
    trigger,
    triggerContext,
    outputContext: target,
    prompt: "Status changed",
  };
}
describe("Linear issue continuation", () => {
  it("rejects changes to the workflow, step, or idle runtime limits", () => {
    assert.equal(
      canContinueIssueWork(intent, "revision", {
        ...trigger,
        maxRuntimeMs: trigger.maxRuntimeMs + 1,
      }),
      false,
    );
    for (const field of ["maxRuntimeMs", "idleTimeoutMs"] as const) {
      assert.equal(
        canContinueIssueWork(intent, "revision", {
          ...trigger,
          steps: [{ ...trigger.steps[0]!, [field]: trigger.steps[0]![field] + 1 }],
        }),
        false,
      );
    }
  });
  it("accepts another trigger only with the same saved runtime, prompt and output authority", () => {
    assert.equal(canContinueIssueWork(intent, "revision", trigger), true);
    assert.equal(canContinueIssueWork(intent, "new-revision", trigger), false);
    assert.equal(
      canContinueIssueWork(intent, "revision", {
        ...trigger,
        steps: [{ ...trigger.steps[0]!, prompt: [{ kind: "text", value: "Deploy now" }] }],
      }),
      false,
    );
    assert.equal(
      canContinueIssueWork(intent, "revision", {
        ...trigger,
        filters: { ...trigger.filters, team: "different" },
      }),
      false,
    );
  });
  it("steers the same immutable issue and replaces both event and native reply destination", async () => {
    const result = await continueLinearIssue(
      input(async (request) => {
        assert.equal(request.activeTurnBehavior, "steer");
        assert.equal(request.inputId, "event-key");
        assert.deepEqual(request.turnContext, { triggerContext, outputContext: target });
        assert.equal(
          request.matches({
            outputContext: { ...target, agentSessionId: "old-session" },
            triggerRunId: "run",
            launchIntent: intent,
          }),
          true,
        );
        assert.equal(
          request.matches({
            outputContext: { ...target, issueId: "other-issue" },
            triggerRunId: "run",
            launchIntent: intent,
          }),
          false,
        );
        return { live: true, delivered: true };
      }),
    );
    assert.equal(result, true);
  });
  it("keeps the event pending when the existing issue agent cannot receive it", async () => {
    await assert.rejects(
      continueLinearIssue(input(async () => ({ live: true, delivered: false }))),
      /temporarily unreachable/,
    );
  });
  it("does not start a concurrent agent after a configuration change", async () => {
    await assert.rejects(
      continueLinearIssue(
        input(async (request) => {
          request.matches({
            outputContext: target,
            triggerRunId: "run",
            launchIntent: { ...intent, configurationRevisionId: "old-revision" },
          });
          return { live: false, delivered: false };
        }),
      ),
      /different saved configuration/,
    );
  });
  it("allows a fresh execution after the previous agent has ended", async () => {
    assert.equal(
      await continueLinearIssue(input(async () => ({ live: false, delivered: false }))),
      false,
    );
  });
});
