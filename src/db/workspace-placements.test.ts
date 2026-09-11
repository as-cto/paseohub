import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { WorkspacePlacementConflictError } from "./workspace-placements.js";

it("atomically reserves one permanent placement per work identity without coupling it to an execution", async () => {
  const database = createMemoryDatabase();
  const input = {
    organizationId: "org",
    workspaceKey: "issue",
    projectId: randomUUID(),
    daemonId: randomUUID(),
    sourceCwd: "/repo",
    firstExecutionId: randomUUID(),
  };
  const results = await Promise.allSettled([
    database.claimWorkspacePlacement(input),
    database.claimWorkspacePlacement({ ...input, daemonId: randomUUID() }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const reused = await database.claimWorkspacePlacement({
    ...input,
    firstExecutionId: randomUUID(),
  });
  assert.equal(reused.firstExecutionId, input.firstExecutionId);
  for (const replacement of [{ projectId: randomUUID() }, { sourceCwd: "/other" }]) {
    await assert.rejects(
      database.claimWorkspacePlacement({ ...input, ...replacement }),
      WorkspacePlacementConflictError,
    );
  }
  const other = await database.claimWorkspacePlacement({
    ...input,
    organizationId: "other-org",
    daemonId: randomUUID(),
  });
  assert.equal(other.organizationId, "other-org");
});

it("serializes a Linear issue across connection replacement without transferring workspace authority", async () => {
  const database = createMemoryDatabase();
  const key = (connection: string, issue = "issue-uuid") =>
    JSON.stringify(["org", JSON.stringify(["linear", connection, "linear-org", issue])]);
  const input = {
    organizationId: "org",
    workspaceKey: key("original"),
    projectId: randomUUID(),
    daemonId: randomUUID(),
    sourceCwd: "/repo",
    firstExecutionId: randomUUID(),
  };
  const claims = await Promise.allSettled([
    database.claimWorkspacePlacement(input),
    database.claimWorkspacePlacement({ ...input, workspaceKey: key("replacement") }),
  ]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const winner = claims.find((claim) => claim.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  const otherConnection =
    winner.value.workspaceKey === key("original") ? "replacement" : "original";
  await assert.rejects(
    database.claimWorkspacePlacement({ ...input, workspaceKey: key(otherConnection) }),
    WorkspacePlacementConflictError,
  );
  assert.equal(
    (await database.claimWorkspacePlacement(winner.value)).firstExecutionId,
    winner.value.firstExecutionId,
  );
  await database.claimWorkspacePlacement({
    ...input,
    workspaceKey: key("replacement", "other-issue"),
  });
});
