import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "./compiler.js";

function config(filters: Record<string, unknown>, on = "linear.delegated_issue_updated") {
  return {
    environments: [{ name: "issue", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "intake",
        on,
        max_runtime: "1h",
        filters,
        steps: [
          {
            id: "run",
            environment: "issue",
            max_runtime: "1h",
            idle_timeout: "3m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work" }],
          },
        ],
      },
    ],
  };
}
const filters = {
  team: "team",
  connection: "linear",
  from_users: ["human"],
  intake_triage_state_id: "triage",
};
describe("explicit Triage intake policy", () => {
  it("preserves an explicit scoped policy during compilation", () => {
    assert.equal(
      compileHubConfig(config(filters)).triggers[0]?.filters?.intake_triage_state_id,
      "triage",
    );
  });
  it.each(["team", "connection", "from_users"])("requires %s", (field) => {
    const changed: Record<string, unknown> = { ...filters };
    delete changed[field];
    assert.throws(() => compileHubConfig(config(changed)), /intake_triage_state_id/u);
  });
  it("rejects a wildcard actor or a policy attached to another event", () => {
    assert.throws(
      () => compileHubConfig(config({ ...filters, from_users: ["*"] })),
      /intake_triage_state_id/u,
    );
    assert.throws(
      () => compileHubConfig(config(filters, "linear.comment_created")),
      /intake_triage_state_id/u,
    );
  });
});
