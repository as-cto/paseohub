import assert from "node:assert/strict";
import { dump } from "js-yaml";
import { describe, it } from "vitest";
import type { HubBundleFile } from "../config/bundle.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { LinearConnectionRecord } from "../db/types.js";
import { configurationBundleFixture } from "../test-utils/configuration-bundle.js";
import {
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import {
  ConfigurationActivationValidationError,
  ProjectConfigurationStore,
  type DaemonAgentConfigurationValidator,
} from "./store.js";

const linear: LinearConnectionRecord = {
  id: "00000000-0000-4000-8000-000000000003",
  organizationId: "org_1",
  slug: "acme-linear",
  providerApplicationId: "linear-app",
  linearOrganizationId: "linear-org-1",
  linearOrganizationName: "Acme",
  appUserId: "app-user-1",
  accessToken: "test-token",
  refreshToken: "test-refresh-token",
  accessTokenExpiresAt: null,
  scopes: ["read", "write", "app:assignable", "app:mentionable"],
};

describe("Linear issue workspace configuration requirements", () => {
  it.each([false, true])(
    "rejects unsupported issue reuse before provider validation (named=%s)",
    async (named) => {
      const harness = await setup("workspace_binding_unsupported");
      const files = bindingFiles({ named });
      const validation = await harness.store.validateBundle(files);
      assert.equal(validation.valid, false);
      assert.match(JSON.stringify(validation), /workspace_binding_unsupported/u);
      assert.equal(harness.providerChecks, 0);
      const record = await harness.store.insertManualBundleRevision({ files, userId: null });
      assert.notEqual(record.validationErrors, null);
      await assert.rejects(
        harness.store.activate(record.id),
        ConfigurationActivationValidationError,
      );
      assert.equal(await harness.store.getActive(), undefined);
      assert.equal(harness.providerChecks, 0);
    },
  );

  it("distinguishes an offline daemon from an unsupported connected daemon", async () => {
    const harness = await setup("daemon_not_connected");
    const result = await harness.store.validateBundle(bindingFiles());
    assert.equal(result.valid, false);
    assert.match(JSON.stringify(result), /daemon_not_connected/u);
    assert.doesNotMatch(JSON.stringify(result), /workspace_binding_unsupported/u);
  });

  it.each(["linear.comment_created", "manual.run"])(
    "checks explicit workspace bindings even without reuse on %s",
    async (on) => {
      const harness = await setup("workspace_binding_unsupported");
      const result = await harness.store.validateBundle(
        bindingFiles({ on, reuse: false, workspaceKey: "authored-binding" }),
      );
      assert.equal(result.valid, false);
      assert.match(JSON.stringify(result), /workspace_binding_unsupported/u);
    },
  );

  it("fails closed when the validator lacks the workspace capability check", async () => {
    const harness = await setup("supported");
    const store = new ProjectConfigurationStore(harness.database, harness.project.id, {
      validateAgentConfiguration: async () => ({ valid: true }),
    });
    const result = await store.validateBundle(bindingFiles());
    assert.equal(result.valid, false);
    assert.match(JSON.stringify(result), /workspace_binding_validation_unavailable/u);
  });

  it("activates an inline Linear agent when the selected daemon supports binding", async () => {
    const harness = await setup("supported");
    const files = bindingFiles();
    assert.deepEqual(await harness.store.validateBundle(files), { valid: true });
    const record = await harness.store.insertManualBundleRevision({ files, userId: null });
    await harness.store.activate(record.id);
    assert.equal((await harness.store.getActive())?.revision.id, record.id);
    assert.equal(harness.providerChecks, 0);
  });

  it("rechecks capability after route compilation and preserves the active revision on disconnect", async () => {
    const harness = await setup("supported");
    const ordinary = await harness.store.insertManualBundleRevision({
      files: bindingFiles({ reuse: false }),
      userId: null,
    });
    await harness.store.activate(ordinary.id);
    const bound = await harness.store.insertManualBundleRevision({
      files: bindingFiles(),
      userId: null,
    });
    const findProject = harness.database.findProjectById.bind(harness.database);
    harness.database.findProjectById = async (id) => {
      const project = await findProject(id);
      harness.setStatus("daemon_not_connected");
      return project;
    };
    await assert.rejects(harness.store.activate(bound.id), ConfigurationActivationValidationError);
    assert.equal((await harness.store.getActive())?.revision.id, ordinary.id);
  });

  it("rechecks capability after asynchronous named-agent validation", async () => {
    const harness = await setup("supported");
    const store = new ProjectConfigurationStore(harness.database, harness.project.id, {
      validateWorkspaceBinding: (daemonId) => harness.validator.validateWorkspaceBinding!(daemonId),
      async validateAgentConfiguration() {
        harness.setStatus("workspace_binding_unsupported");
        return { valid: true };
      },
    });
    const result = await store.validateBundle(bindingFiles({ named: true }));
    assert.equal(result.valid, false);
    assert.match(JSON.stringify(result), /workspace_binding_unsupported/u);
  });

  it("does not reactivate a bound rollback target on an incompatible daemon", async () => {
    const harness = await setup("supported");
    const bound = await harness.store.insertManualBundleRevision({
      files: bindingFiles(),
      userId: null,
    });
    await harness.store.activate(bound.id);
    const ordinary = await harness.store.insertManualBundleRevision({
      files: bindingFiles({ reuse: false }),
      userId: null,
    });
    await harness.store.activate(ordinary.id);
    harness.setStatus("workspace_binding_unsupported");
    await assert.rejects(harness.store.rollback(), ConfigurationActivationValidationError);
    assert.equal((await harness.store.getActive())?.revision.id, ordinary.id);
  });

  it.each([
    { choices: ["ordinary"], valid: true },
    { choices: ["ordinary", "issue"], valid: false },
  ])("checks only reachable dynamic environment choices $choices", async ({ choices, valid }) => {
    const harness = await setup("workspace_binding_unsupported");
    const files = bindingFiles({ unused: true });
    const workflow = files.find((file) => file.path === ".paseo/workflows/respond.yml")!;
    workflow.content = workflow.content.replace(
      "environment: ordinary",
      "environment: ${{ paseo.inputs.runner }}",
    );
    workflow.content += dump({
      inputs: { runner: { type: "string", choices, default: "ordinary" } },
    });
    const result = await harness.store.validateBundle(files);
    assert.equal(result.valid, valid);
    assert.equal(harness.bindingChecks > 0, !valid);
  });

  it.each([
    { name: "manual route", on: "manual.run" },
    { name: "Linear without reuse", reuse: false },
    { name: "Linear without worktree", worktree: false },
    { name: "unused bound environment", unused: true },
  ])("keeps $name configurable without the companion", async (options) => {
    const harness = await setup("workspace_binding_unsupported");
    const files = bindingFiles(options);
    assert.deepEqual(await harness.store.validateBundle(files), { valid: true });
    const record = await harness.store.insertManualBundleRevision({ files, userId: null });
    await harness.store.activate(record.id);
    assert.equal((await harness.store.getActive())?.revision.id, record.id);
    assert.equal(harness.bindingChecks, 0);
  });
});

type BindingStatus = "supported" | "workspace_binding_unsupported" | "daemon_not_connected";

async function setup(initialStatus: BindingStatus) {
  const database = createMemoryDatabase();
  await enrollTestDaemon(database);
  database.organizationConnectionUsage = async () => ({
    github: [],
    slack: [],
    discord: [],
    linear: [linear],
  });
  database.findLinearConnection = async () => linear;
  const project = await database.createProject({
    organizationId: "org_1",
    name: "Bindings",
    slug: "bindings",
    createdByUserId: null,
  });
  let status = initialStatus;
  let providerChecks = 0;
  let bindingChecks = 0;
  const validator: DaemonAgentConfigurationValidator = {
    validateWorkspaceBinding(daemonId) {
      assert.equal(daemonId, TEST_DAEMON_ID);
      bindingChecks += 1;
      return status === "supported"
        ? { valid: true }
        : {
            valid: false,
            issues: [{ path: [], message: `${status}: Daemon cannot bind this issue workspace.` }],
          };
    },
    async validateAgentConfiguration() {
      providerChecks += 1;
      return { valid: true };
    },
  };
  return {
    database,
    project,
    validator,
    store: new ProjectConfigurationStore(database, project.id, validator),
    setStatus(value: BindingStatus) {
      status = value;
    },
    get providerChecks() {
      return providerChecks;
    },
    get bindingChecks() {
      return bindingChecks;
    },
  };
}

function bindingFiles(
  options: {
    named?: boolean;
    on?: string;
    reuse?: boolean;
    worktree?: boolean;
    unused?: boolean;
    workspaceKey?: string;
  } = {},
): HubBundleFile[] {
  const on = options.on ?? "linear.comment_created";
  const files = configurationBundleFixture(
    dump({
      environments: [
        {
          name: "issue",
          kind: "daemon",
          daemon: TEST_DAEMON_SLUG,
          cwd: "/repo",
          ...(options.worktree === false
            ? {}
            : {
                worktree: {
                  mode: "branch-off",
                  newBranch: "issue",
                  reuseWorkspace: options.reuse ?? true,
                  ...(options.workspaceKey === undefined
                    ? {}
                    : { workspaceKey: options.workspaceKey }),
                },
              }),
        },
        ...(options.unused
          ? [{ name: "ordinary", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }]
          : []),
      ],
      triggers: [
        {
          name: "respond",
          on,
          max_runtime: "1h",
          ...(on.startsWith("linear.")
            ? { filters: { connection: linear.slug, team: "team-1", from_users: ["human-1"] } }
            : {}),
          steps: [
            {
              id: "work",
              environment: options.unused ? "ordinary" : "issue",
              max_runtime: "30m",
              idle_timeout: "5m",
              agent: options.named ? "worker" : { provider: "codex" },
              prompt: [{ text: "Handle this issue" }],
            },
          ],
        },
      ],
    }),
  );
  if (options.named) {
    const hub = files.find((file) => file.path === ".paseo/hub.yml")!;
    hub.content = hub.content.replace("agents: {}", "agents:\n  worker:\n    provider: codex");
  }
  return files;
}
