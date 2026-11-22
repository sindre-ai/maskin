-- Rollback for 0148_workspace_ai_usage.sql. Transcription spend recorded so far stops counting toward
-- plan usage, so a workspace that was near its cap reads lower after this. Roll back the code that
-- reads workspace_ai_usage first (getWorkspacePlanUsdCentsUsage, readUsageBreakdown, transcribe_file).
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "workspace_ai_usage";
