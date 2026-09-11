import type { Database, LinearWebhookInboxRecord } from "../../db/types.js";
import { logger } from "../../logger.js";

export type LinearWebhookInboxStore = Pick<
  Database,
  | "admitLinearWebhook"
  | "listPendingLinearWebhooks"
  | "findLinearWebhook"
  | "settleLinearWebhook"
  | "withAdvisoryLock"
>;

// Source versions can overlap during configuration rotation. Waiting for capacity must happen
// before taking an advisory connection from the shared pool, including across those versions.
const inboxHandoffs = new WeakMap<LinearWebhookInboxStore, Promise<void>>();

async function withInboxCapacity(
  database: LinearWebhookInboxStore,
  handoff: () => Promise<void>,
): Promise<void> {
  const previous = inboxHandoffs.get(database) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(handoff);
  inboxHandoffs.set(database, current);
  try {
    await current;
  } finally {
    if (inboxHandoffs.get(database) === current) inboxHandoffs.delete(database);
  }
}

/** PostgreSQL owns pending work; timers merely provide a prompt wakeup and recover after restart. */
export class LinearWebhookInboxWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private drain: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly options: {
      database: LinearWebhookInboxStore;
      applicationId: string;
      handle: (row: LinearWebhookInboxRecord) => Promise<void>;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.drain;
  }

  wake(): void {
    if (!this.started || this.drain !== undefined) return;
    this.drain = this.run()
      .catch((error: unknown) => {
        logger.error(
          { err: error, applicationId: this.options.applicationId },
          "Linear webhook inbox drain failed; will retry",
        );
      })
      .finally(() => {
        this.drain = undefined;
      });
  }

  private async run(): Promise<void> {
    const rows = await this.options.database.listPendingLinearWebhooks(
      this.options.applicationId,
      this.now(),
      2,
    );
    for (const row of rows) await this.deliver(row.id);
  }

  private async deliver(id: string): Promise<void> {
    await withInboxCapacity(this.options.database, async () => {
      if (!this.started) return;
      await this.deliverWithLock(id);
    });
  }

  private async deliverWithLock(id: string): Promise<void> {
    await this.options.database.withAdvisoryLock(`linear.webhook:${id}`, async () => {
      if (!this.started) return;
      const row = await this.options.database.findLinearWebhook(id);
      if (row === undefined || row.completedAt !== null || row.nextAttemptAt > this.now()) return;
      try {
        await this.options.handle(row);
        await this.options.database.settleLinearWebhook(id, { completedAt: this.now() });
      } catch (error) {
        const retryDelay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
        logger.error(
          { err: error, deliveryId: row.deliveryId, attempt: row.attempts + 1 },
          "Linear webhook processing failed; persisted for retry",
        );
        await this.options.database.settleLinearWebhook(id, {
          retryAt: new Date(this.now().getTime() + retryDelay),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private now(): Date {
    return new Date(this.options.now?.() ?? Date.now());
  }
}
