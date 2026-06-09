ALTER TABLE "workspaces" ADD COLUMN "onboarding_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "workspace_onboarding_prompts" (
	"workspace_id" uuid NOT NULL,
	"prompt_type" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"object_id" uuid,
	CONSTRAINT "workspace_onboarding_prompts_pkey" PRIMARY KEY("workspace_id","prompt_type")
);
--> statement-breakpoint
ALTER TABLE "workspace_onboarding_prompts" ADD CONSTRAINT "workspace_onboarding_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_onboarding_prompts" ADD CONSTRAINT "workspace_onboarding_prompts_prompt_type_check" CHECK ("prompt_type" IN ('product_vision','icp','first_bet_hypothesis','north_star_metric','customer_evidence'));