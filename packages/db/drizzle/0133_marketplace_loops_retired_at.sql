-- Marketplace loops can be retired: hidden from the marketplace and from new installs, while
-- the row stays in place so workspaces that already installed the loop keep their install
-- (installed_loops.source_loop_id has no ON DELETE rule, and the version pusher, the installed
-- list and uninstall all join on this row). seedMarketplaceLoops sets retired_at on rows whose
-- slug is no longer in the code-defined seed list, and clears it for a slug that comes back.
--
-- Nullable column with no default, so existing rows are untouched (all stay listed) and the
-- ALTER is a metadata-only change. marketplace_loops is a handful of rows and not on the
-- hot-tables list (see MIGRATIONS.md), so plain DDL is fine.
-- Down: drizzle/down/0133_marketplace_loops_retired_at_down.sql.

ALTER TABLE "marketplace_loops" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
