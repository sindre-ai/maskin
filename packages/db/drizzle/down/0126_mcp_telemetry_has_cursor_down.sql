-- Rollback for 0126. Drops the paging flag on list-call telemetry rows. Nothing reads it
-- except the list-tools bet's baseline query; the object_type values written alongside stay.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "mcp_telemetry" DROP COLUMN IF EXISTS "has_cursor";
