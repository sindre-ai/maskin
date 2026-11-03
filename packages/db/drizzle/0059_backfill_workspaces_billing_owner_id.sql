-- Backfill: every existing workspace's billing_owner_id becomes its earliest-
-- joined role='owner' HUMAN member (agents are never billing owners), falling
-- back to created_by when no such member row exists. Idempotent
-- (WHERE billing_owner_id IS NULL) so it's safe to re-run.
--
-- Single-pass UPDATE, not chunked per MIGRATIONS.md Rule 2 — `workspaces` is
-- not on the hot-tables list and is expected to be small (thousands, not
-- millions, of rows) at migration time. Called out here per Rule 2's carve-out
-- for tables under that bar.
UPDATE "workspaces" w
SET "billing_owner_id" = COALESCE(
	(
		SELECT wm.actor_id
		FROM "workspace_members" wm
		INNER JOIN "actors" a ON a.id = wm.actor_id
		WHERE wm.workspace_id = w.id
			AND wm.role = 'owner'
			AND a.type = 'human'
		ORDER BY wm.joined_at ASC NULLS LAST, wm.actor_id ASC
		LIMIT 1
	),
	w.created_by
)
WHERE w.billing_owner_id IS NULL;
