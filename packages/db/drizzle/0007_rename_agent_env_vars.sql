-- Migrate agent MCP configs from old AI_NATIVE_* env var placeholders to MASKIN_*
-- These template strings are stored in actors.tools JSONB and expanded via envsubst at container runtime.
UPDATE actors
SET tools = REPLACE(REPLACE(REPLACE(
  tools::text,
  '${AI_NATIVE_API_URL}', '${MASKIN_API_URL}'),
  '${AI_NATIVE_API_KEY}', '${MASKIN_API_KEY}'),
  '${AI_NATIVE_WORKSPACE_ID}', '${MASKIN_WORKSPACE_ID}')::jsonb
WHERE tools IS NOT NULL
  AND tools::text LIKE '%AI_NATIVE%';
