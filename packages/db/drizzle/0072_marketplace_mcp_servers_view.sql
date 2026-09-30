-- Postgres view projecting MCP Registry rows through the CatalogItemCard
-- shape used by GET /api/marketplace/catalog (Marketplace tech spec §2.3,
-- §6.1). Marketplace never duplicates Registry logic — this view is a
-- viewport onto `mcp_registry_entries` so the catalog handler can UNION-ALL
-- across all four item_kinds uniformly.
--
-- The MCP Registry bet ships its schema (`mcp_registry_entries` +
-- `mcp_installations`) in a separate sequence. Until it lands, this file
-- creates the view with the target column shape but an empty projection,
-- which:
--   1. satisfies the acceptance criterion "view marketplace_mcp_servers
--      exists projecting through the shape in §2.3",
--   2. keeps the /api/marketplace/catalog UNION-ALL from crashing at
--      runtime (the mcp_server branch simply returns zero rows), and
--   3. is DROP+RECREATE-safe — when the Registry PR lands, it replaces
--      this file's body with the SELECT ... FROM mcp_registry_entries per
--      §2.3 (same column names, same types) and no downstream code needs
--      to change.
DROP VIEW IF EXISTS "marketplace_mcp_servers";
--> statement-breakpoint
CREATE VIEW "marketplace_mcp_servers" AS
SELECT
	NULL::uuid           AS id,
	NULL::uuid           AS workspace_id,
	NULL::text           AS slug,
	NULL::text           AS display_name,
	NULL::text           AS description,
	NULL::text           AS outcome_line,
	'shared'::text       AS team,
	'{}'::jsonb          AS recommendation,
	'{}'::jsonb          AS requires,
	'published'::text    AS status,
	0::integer           AS sort_weight,
	0::integer           AS install_count,
	NULL::timestamptz    AS created_at,
	NULL::timestamptz    AS updated_at
WHERE false;
