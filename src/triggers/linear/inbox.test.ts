import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { LinearWebhookInboxRecord } from "../../db/types.js";
import { LinearWebhookInboxWorker } from "./inbox.js";

describe("Linear inbox database capacity", () => {
  it("shares one advisory connection slot across a burst of overlapping workers and applications", async () => {
    const now = new Date();
    const database = createMemoryDatabase({ now: () => now });
    const admitted = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        database.admitLinearWebhook({
          applicationId: `app-${index % 4}`,
          configurationVersion: 1,
          deliveryId: `delivery-${index}`,
          signatureHash: `signature-${index}`,
          eventName: "AgentSessionEvent",
          payload: { index },
          receivedAt: now,
        }),
      ),
    );
    const underlyingLock = database.withAdvisoryLock.bind(database);
    let reserved = 0;
    let peakReserved = 0;
    database.withAdvisoryLock = async (key, operation) => {
      const inbox = key.startsWith("linear.webhook:");
      if (inbox) {
        reserved++;
        peakReserved = Math.max(peakReserved, reserved);
      }
      try {
        return await underlyingLock(key, operation);
      } finally {
        if (inbox) reserved--;
      }
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let handled = 0;
    async function handle(row: LinearWebhookInboxRecord): Promise<void> {
      handled++;
      const first = handled === 1;
      // Model a real handoff's nested execution lock and query while the inbox lock remains
      // held. Other inbox workers must wait before reserving their connection.
      await database.withAdvisoryLock(`execution.prompt:${row.id}`, async () => {
        assert.ok(await database.findLinearWebhook(row.id));
        if (first) {
          started();
          await held;
        }
      });
    }
    const workers = Array.from(
      { length: 4 },
      (_, index) =>
        new LinearWebhookInboxWorker({
          database,
          applicationId: `app-${index}`,
          now: () => now.getTime(),
          handle,
        }),
    );
    workers.forEach((worker) => worker.start());
    try {
      await firstStarted;
      release();
      await vi.waitFor(async () => {
        for (const row of admitted)
          assert.ok((await database.findLinearWebhook(row.id))?.completedAt);
      });
    } finally {
      release();
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    assert.equal(handled, 8);
    assert.equal(peakReserved, 1);
    assert.equal(reserved, 0);
  });
});
