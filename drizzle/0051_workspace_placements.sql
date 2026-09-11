CREATE TABLE "workspace_placements" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_key" text NOT NULL,
	"project_id" uuid NOT NULL,
	"daemon_id" uuid NOT NULL,
	"source_cwd" text NOT NULL,
	"first_execution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_placements" ADD CONSTRAINT "workspace_placements_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;