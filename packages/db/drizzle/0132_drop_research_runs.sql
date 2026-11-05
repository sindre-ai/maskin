-- Drops the deep_research run table created in 0127. The deep_research tool, its routes and the
-- code that read this table are removed in the same change (Magnus, 5 Nov 2026: back to the
-- Researcher agent). The feature flag was off and the table is empty in production, nothing
-- else reads it. 0127 is left as shipped; this is the forward step.
--
-- Not on the hot-tables list (see MIGRATIONS.md), so a plain DROP is fine. The indexes,
-- constraints and the row-level security policy go with the table.
-- Down: drizzle/down/0132_drop_research_runs_down.sql.
DROP TABLE IF EXISTS "research_runs";
