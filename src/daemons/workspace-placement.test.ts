import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { createDaemonDispatchLifecycle, DaemonDispatchFailure } from "./lifecycle.js";
import type { DaemonConnection } from "./protocol.js";

it.each(["dispatch", "handoff", "recover"] as const)(
  "checks permanent workspace placement before %s can contact an agent",
  async (mode) => {
    const database = createMemoryDatabase();
    const organizationId = "workspace-org";
    const project = await database.createProject({
      organizationId,
      name: "Workspace",
      slug: "workspace",
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: {},
      contentHash: "workspace",
    });
    await database.issueEnrollmentToken({
      id: randomUUID(),
      verifier: "workspace-enrollment",
      organizationId,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    const daemon = await database.enrollDaemon({
      daemonId: randomUUID(),
      idempotencyKey: "workspace",
      tokenVerifier: "workspace-enrollment",
      serverId: "workspace-server",
      daemonPublicKey: "public",
      credentialVerifier: "verifier",
      permissions: ["hub.execute"],
      now: new Date(),
    });
    assert.ok(daemon && "machineId" in daemon);
    const { run } = await database.createAcceptedTriggerRun({
      organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: "receipt",
      configuredTriggerName: "workspace",
      prompt: "continue",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(Date.now() + 60_000),
      stepIds: [],
    });
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId,
      projectId: project.id,
      triggerRunId: run.id,
      triggerName: "workspace",
      environmentName: "runner",
      configurationRevisionId: revision.id,
      environment: {
        kind: "daemon",
        daemonId: daemon.id,
        authoredSlug: daemon.slug,
        cwd: "/changed",
        worktree: {
          mode: "branch-off",
          newBranch: "renamed",
          reuseWorkspace: true,
          workspaceKey: "stable-issue",
        },
      },
      prompt: "continue",
      agent: { provider: "codex" },
      allowOutputs: [],
      autoArchive: false,
      triggerContext: {},
      outputContext: {},
      hubConfig: {},
    };
    await database.claimWorkspacePlacement({
      organizationId,
      workspaceKey: "stable-issue",
      projectId: project.id,
      daemonId: daemon.id,
      sourceCwd: "/original",
      firstExecutionId: randomUUID(),
    });
    const createAgent = vi.fn(async () => ({ id: "must-not-create" }));
    const connection: DaemonConnection = {
      createAgent,
      on: () => () => {},
      controlExecution: async () => {},
      promptExecution: async () => ({ delivered: false, disposition: null }),
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => connection,
      publicBaseUrl: "http://hub.test",
      completionTokenSecret: "test-secret",
    });
    try {
      if (mode === "dispatch") {
        await assert.rejects(lifecycle.dispatchLaunchMachineIntent(intent), {
          name: DaemonDispatchFailure.name,
          reason: "workspace_placement_conflict",
        });
      } else if (mode === "handoff") {
        const result = await lifecycle.handoffLaunchMachineIntent(intent);
        assert.equal(result.execution.status, "failed");
        assert.match(JSON.stringify(result.execution.result), /workspace_placement_conflict/u);
      } else {
        const execution = await database.insertAgentExecution({
          id: randomUUID(),
          organizationId,
          projectId: project.id,
          daemonId: daemon.id,
          machineId: daemon.machineId,
          triggerContext: {},
          outputContext: {},
          configurationRevisionId: revision.id,
          launchIntent: intent,
        });
        await lifecycle.recoverDaemon(daemon);
        assert.equal((await database.findAgentExecutionById(execution.id))?.status, "failed");
      }
      assert.equal(createAgent.mock.calls.length, 0);
    } finally {
      await lifecycle.stop();
    }
  },
);
