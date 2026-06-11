-- Backfill the Maskin MCP onto agents created before PR #346.
-- That PR defaulted tools.mcpServers.maskin = PLATFORM_MCP_PRESET in
-- POST /api/actors, but only for newly-created agents — pre-existing agents
-- still boot without the Maskin MCP and can't read or write workspace data.
--
-- This migration adds the same preset to any agent missing it. Existing
-- maskin entries (and any other mcpServers) are preserved; we only fill the
-- gap. Placeholders like ${MASKIN_API_URL} are literal strings here — they
-- are expanded via envsubst at container runtime by the session manager.
UPDATE actors
SET tools = jsonb_set(
  COALESCE(tools, '{}'::jsonb),
  '{mcpServers}',
  COALESCE(tools->'mcpServers', '{}'::jsonb) || jsonb_build_object(
    'maskin', jsonb_build_object(
      'type', 'http',
      'url', '${MASKIN_API_URL}/mcp',
      'headers', jsonb_build_object(
        'Authorization', 'Bearer ${MASKIN_API_KEY}',
        'X-Workspace-Id', '${MASKIN_WORKSPACE_ID}'
      )
    )
  ),
  true
)
WHERE type = 'agent'
  AND (tools IS NULL OR tools->'mcpServers'->'maskin' IS NULL);
