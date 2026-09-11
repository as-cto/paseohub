CREATE TABLE "linear_issue_session_bridges" (
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"linear_organization_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"event_key" text NOT NULL,
	"marker_url" text NOT NULL,
	"app_user_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"source_actor_id" text NOT NULL,
	"source_body" text NOT NULL,
	"session_id" text,
	"creation_started_at" timestamp with time zone,
	"lease_id" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linear_issue_session_bridges_organization_id_project_id_connection_id_linear_organization_id_issue_id_event_key_pk" PRIMARY KEY("organization_id","project_id","connection_id","linear_organization_id","issue_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "linear_issue_session_bridges" ADD CONSTRAINT "linear_issue_session_bridge_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue_session_bridges" ADD CONSTRAINT "linear_issue_session_bridge_receipt_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;