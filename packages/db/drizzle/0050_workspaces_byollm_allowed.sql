ALTER TABLE "workspaces" ADD COLUMN "byollm_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Explicit exception list: only these workspaces may use BYO LLM credentials
-- (Claude OAuth, custom_llm, llm_keys). Every other workspace routes through
-- the Maskin-provided LLM plan (trial -> starter/pro). Production workspace
-- IDs, harmless no-op on databases that don't contain them (dev/CI). See PR #970.
UPDATE "workspaces" SET "byollm_allowed" = true
WHERE "id" IN (
	'fe944fe6-7b45-478c-afc7-b889cea63c08',
	'2b95807b-26f8-424c-8e35-8bee8ed57f7d',
	'd4dc59dd-a79c-44e8-b4e3-7b5ae4132157'
);
