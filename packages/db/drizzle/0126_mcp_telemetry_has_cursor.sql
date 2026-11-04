-- Whether a list-family tool call carried a cursor or offset.
--
-- The list-tools bet measures "list then search" retries as two list calls on the same
-- object type within 5 calls, paging excluded. mcp_telemetry stored neither the object type
-- a list call asked for nor whether it was paging. The object type reuses the existing
-- object_type column (tool_call rows left it null); this adds the paging flag. A yes/no only:
-- no cursor contents and no offset values are stored.
--
-- Nullable, no default: a metadata-only change, existing rows stay null, and every tool
-- other than the six list-family tools keeps writing null. mcp_telemetry is not on the
-- hot-tables list (see MIGRATIONS.md), so plain DDL is fine and there is nothing to backfill.
-- Down: drizzle/down/0126_mcp_telemetry_has_cursor_down.sql.

ALTER TABLE "mcp_telemetry" ADD COLUMN IF NOT EXISTS "has_cursor" boolean;
