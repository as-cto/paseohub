import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleHandle } from "./runtime/index.js";
import { linearWebhookInbox } from "./schema.js";
import type { LinearWebhookAdmissionInput, LinearWebhookInboxRecord } from "./types.js";

export class LinearWebhookInboxRepository {
  constructor(private readonly database: DrizzleHandle) {}

  async admit(input: LinearWebhookAdmissionInput): Promise<LinearWebhookInboxRecord> {
    const [inserted] = await this.database
      .insert(linearWebhookInbox)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined) return inserted;
    const [prior] = await this.database
      .select()
      .from(linearWebhookInbox)
      .where(
        and(
          eq(linearWebhookInbox.applicationId, input.applicationId),
          or(
            eq(linearWebhookInbox.deliveryId, input.deliveryId),
            eq(linearWebhookInbox.signatureHash, input.signatureHash),
          ),
        ),
      )
      .limit(1);
    if (prior === undefined) throw new Error("verified Linear webhook admission unavailable");
    return prior;
  }

  async pending(
    applicationId: string,
    now: Date,
    limit: number,
  ): Promise<LinearWebhookInboxRecord[]> {
    return this.database
      .select()
      .from(linearWebhookInbox)
      .where(
        and(
          eq(linearWebhookInbox.applicationId, applicationId),
          isNull(linearWebhookInbox.completedAt),
          lte(linearWebhookInbox.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(linearWebhookInbox.receivedAt))
      .limit(limit);
  }

  async find(id: string): Promise<LinearWebhookInboxRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(linearWebhookInbox)
      .where(eq(linearWebhookInbox.id, id));
    return row;
  }

  async settle(
    id: string,
    outcome: { completedAt: Date } | { retryAt: Date; error: string },
  ): Promise<void> {
    await this.database
      .update(linearWebhookInbox)
      .set({
        attempts: sql`${linearWebhookInbox.attempts} + 1`,
        ...("completedAt" in outcome
          ? { completedAt: outcome.completedAt, lastError: null }
          : { nextAttemptAt: outcome.retryAt, lastError: outcome.error.slice(0, 2000) }),
      })
      .where(eq(linearWebhookInbox.id, id));
  }
}
