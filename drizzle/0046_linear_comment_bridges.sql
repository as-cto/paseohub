CREATE TABLE "linear_comment_bridges" (
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"linear_organization_id" text NOT NULL,
	"root_comment_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"source_comment_id" text NOT NULL,
	"source_actor_id" text NOT NULL,
	"source_body" text NOT NULL,
	"session_id" text,
	"lease_id" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linear_comment_bridges_organization_id_project_id_connection_id_linear_organization_id_root_comment_id_pk" PRIMARY KEY("organization_id","project_id","connection_id","linear_organization_id","root_comment_id")
);
--> statement-breakpoint
ALTER TABLE "linear_comment_bridges" ADD CONSTRAINT "linear_comment_bridge_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_comment_bridges" ADD CONSTRAINT "linear_comment_bridge_receipt_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;