-- Tokens-per-tool-result (bet's secondary success metric, target ≥60% reduction).
-- All three columns are nullable so rows recorded before this migration (and
-- non-tool_call rows like mutation/deep_link_click) can co-exist.
ALTER TABLE "mcp_telemetry" ADD COLUMN IF NOT EXISTS "content_bytes" integer;
ALTER TABLE "mcp_telemetry" ADD COLUMN IF NOT EXISTS "content_tokens" integer;
ALTER TABLE "mcp_telemetry" ADD COLUMN IF NOT EXISTS "structured_content_bytes" integer;
