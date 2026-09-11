CREATE TABLE "linear_triage_intakes" (
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"linear_organization_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"source" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"attempt_started_at" timestamp with time zone,
	"lease_id" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linear_triage_intakes_pk" PRIMARY KEY("organization_id","project_id","connection_id","linear_organization_id","issue_id"),
	CONSTRAINT "linear_triage_intakes_status_check" CHECK ("linear_triage_intakes"."status" in ('reserved','attempted','applied','ignored','ambiguous'))
);
--> statement-breakpoint
ALTER TABLE "linear_triage_intakes" ADD CONSTRAINT "linear_triage_intake_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_triage_intakes" ADD CONSTRAINT "linear_triage_intake_receipt_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;