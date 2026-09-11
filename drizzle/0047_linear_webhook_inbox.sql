CREATE TABLE "linear_webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"configuration_version" integer NOT NULL,
	"delivery_id" text NOT NULL,
	"signature_hash" text NOT NULL,
	"event_name" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_webhook_inbox_delivery_unique" ON "linear_webhook_inbox" USING btree ("application_id","delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_webhook_inbox_signature_unique" ON "linear_webhook_inbox" USING btree ("application_id","signature_hash");--> statement-breakpoint
CREATE INDEX "linear_webhook_inbox_pending_idx" ON "linear_webhook_inbox" USING btree ("application_id","next_attempt_at") WHERE "linear_webhook_inbox"."completed_at" is null;