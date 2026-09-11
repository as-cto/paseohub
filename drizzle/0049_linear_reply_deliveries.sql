CREATE TABLE "linear_reply_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"turn_key" text NOT NULL,
	"attempt_id" text NOT NULL,
	"application_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"comment_confirmed_at" timestamp with time zone,
	"activity_confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"lease_id" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "linear_reply_deliveries" ADD CONSTRAINT "linear_reply_deliveries_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_reply_deliveries_turn_unique" ON "linear_reply_deliveries" USING btree ("execution_id","turn_key");--> statement-breakpoint
CREATE INDEX "linear_reply_deliveries_pending_idx" ON "linear_reply_deliveries" USING btree ("application_id","next_attempt_at") WHERE "linear_reply_deliveries"."completed_at" is null and "linear_reply_deliveries"."superseded_at" is null;