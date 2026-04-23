-- Enforce the workspace-skill name format at the DB level so non-HTTP writers
-- cannot bypass the Zod regex. Mirrors `skillNameSchema` in
-- packages/shared/src/schemas/workspace-skills.ts (^[a-z0-9-]{1,64}$).
ALTER TABLE "workspace_skills"
ADD CONSTRAINT "workspace_skills_name_format"
CHECK ("name" ~ '^[a-z0-9-]{1,64}$');
