-- Track whether a workspace skill parses as a valid SKILL.md. Invalid skills
-- are still stored so users can edit them in the UI to fix formatting, but
-- they are excluded when agent sessions pull workspace skills.
ALTER TABLE "workspace_skills"
ADD COLUMN "is_valid" boolean NOT NULL DEFAULT true;
