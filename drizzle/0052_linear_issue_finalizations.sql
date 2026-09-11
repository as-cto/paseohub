CREATE TABLE "linear_issue_finalizations" (
	"reply_id" uuid PRIMARY KEY NOT NULL,
	"target" jsonb NOT NULL,
	"previous" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "linear_issue_finalizations" ADD CONSTRAINT "linear_issue_finalizations_reply_id_linear_reply_deliveries_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."linear_reply_deliveries"("id") ON DELETE cascade ON UPDATE no action;