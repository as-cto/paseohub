import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import { WorkspacePlacementConflictError } from "./workspace-placements.js";

it("keeps the unique workspace placement through concurrent claims, restart, and project deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-placement-"));
  let runtime = await embeddedDatabaseRuntime(directory);
  try {
    await runtime.runtime.migrate();
    await runtime.runtime.query(
      "insert into organization (id,name,slug) values ('org','org','org'),('other','other','other')",
    );
    const input = {
      organizationId: "org",
      workspaceKey: "🧑".repeat(1024),
      projectId: randomUUID(),
      daemonId: randomUUID(),
      sourceCwd: "/repo",
      firstExecutionId: randomUUID(),
    };
    await runtime.runtime.query(
      "insert into projects (id,organization_id,name,slug) values ($1,'org','project','project')",
      [input.projectId],
    );
    let database = createDatabase(runtime.runtime, runtime.locks);
    const claims = await Promise.allSettled([
      database.claimWorkspacePlacement(input),
      database.claimWorkspacePlacement({ ...input, daemonId: randomUUID() }),
    ]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    const winner = claims.find((result) => result.status === "fulfilled");
    assert.ok(winner?.status === "fulfilled");
    const linearKey = (connection: string) =>
      JSON.stringify(["org", JSON.stringify(["linear", connection, "linear-org", "issue-uuid"])]);
    const linearClaim = { ...input, workspaceKey: linearKey("original") };
    await database.claimWorkspacePlacement(linearClaim);
    await database.close();
    runtime = await embeddedDatabaseRuntime(directory);
    database = createDatabase(runtime.runtime, runtime.locks);
    const restored = await database.claimWorkspacePlacement({
      ...winner.value,
      firstExecutionId: randomUUID(),
    });
    assert.equal(restored.firstExecutionId, winner.value.firstExecutionId);
    assert.equal(restored.createdAt.getTime(), winner.value.createdAt.getTime());
    await assert.rejects(
      database.claimWorkspacePlacement({ ...linearClaim, workspaceKey: linearKey("replacement") }),
      WorkspacePlacementConflictError,
    );
    assert.equal(
      (await database.claimWorkspacePlacement(linearClaim)).firstExecutionId,
      linearClaim.firstExecutionId,
    );
    for (const changes of [
      { daemonId: randomUUID() },
      { sourceCwd: "/other" },
      { projectId: randomUUID() },
    ]) {
      await assert.rejects(
        database.claimWorkspacePlacement({ ...winner.value, ...changes }),
        WorkspacePlacementConflictError,
      );
    }
    // The first execution need not exist anymore. Removing the project must not remove proof either.
    await runtime.runtime.query("delete from projects where id=$1", [input.projectId]);
    await assert.rejects(
      database.claimWorkspacePlacement({ ...winner.value, projectId: randomUUID() }),
      WorkspacePlacementConflictError,
    );
    await database.claimWorkspacePlacement({
      ...input,
      organizationId: "other",
      daemonId: randomUUID(),
    });
    const count = await runtime.runtime.query<{ count: number }>(
      "select count(*)::integer as count from workspace_placements",
    );
    assert.equal(count.rows[0]?.count, 3);
  } finally {
    await runtime.runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
