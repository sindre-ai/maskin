-- Remove the retired '*-module-loop' marketplace loops.
--
-- The extension loops shipped first as work-module-loop / knowledge-module-loop
-- / crm-module-loop, then were renamed to *-extension-loop when the wording
-- settled on "extension". seedMarketplaceLoops upserts by slug, so the rename
-- inserted three new rows and left the three originals behind — the marketplace
-- showed both.
--
-- Deletion order matters: installed_loops.object_id references objects with no
-- cascade, so the install rows go before the Loop objects they point at. The
-- objects themselves are found via metadata->>'installed_from_marketplace_loop_id'
-- (set by the install route) rather than through installed_loops, since that
-- row is already gone by then. Everything keys off marketplace_loops.slug, so
-- the retired loop rows are deleted last of all.
--
-- Nothing else needs unwinding: these loops only ever shipped an 'extension'
-- item, which provisions no actor/trigger/skill/integration rows. The extension
-- itself stays enabled in workspaces.settings.enabled_modules — same rule the
-- uninstall route follows, and disabling it would hide every object of its
-- types.

-- Edges pointing at a Loop object we're about to delete.
DELETE FROM relationships
WHERE source_id IN (
		SELECT o.id FROM objects o
		WHERE o.type = 'loop'
			AND o.metadata->>'installed_from_marketplace_loop_id' IN (
				SELECT id::text FROM marketplace_loops
				WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
			)
	)
	OR target_id IN (
		SELECT o.id FROM objects o
		WHERE o.type = 'loop'
			AND o.metadata->>'installed_from_marketplace_loop_id' IN (
				SELECT id::text FROM marketplace_loops
				WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
			)
	);

DELETE FROM subscriptions
WHERE entity_type = 'object'
	AND entity_id IN (
		SELECT o.id FROM objects o
		WHERE o.type = 'loop'
			AND o.metadata->>'installed_from_marketplace_loop_id' IN (
				SELECT id::text FROM marketplace_loops
				WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
			)
	);

DELETE FROM read_state
WHERE entity_type = 'object'
	AND entity_id IN (
		SELECT o.id FROM objects o
		WHERE o.type = 'loop'
			AND o.metadata->>'installed_from_marketplace_loop_id' IN (
				SELECT id::text FROM marketplace_loops
				WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
			)
	);

-- Frees the object_id FK so the Loop objects can go next.
DELETE FROM installed_loops
WHERE source_loop_id IN (
	SELECT id FROM marketplace_loops
	WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
);

DELETE FROM objects
WHERE type = 'loop'
	AND metadata->>'installed_from_marketplace_loop_id' IN (
		SELECT id::text FROM marketplace_loops
		WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
	);

-- Items cascade on the loop delete, but drop them explicitly so the intent is
-- readable and the statement is safe to run against a DB where the cascade was
-- ever altered.
DELETE FROM marketplace_loop_items
WHERE loop_id IN (
	SELECT id FROM marketplace_loops
	WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop')
);

DELETE FROM marketplace_loops
WHERE slug IN ('work-module-loop', 'knowledge-module-loop', 'crm-module-loop');
