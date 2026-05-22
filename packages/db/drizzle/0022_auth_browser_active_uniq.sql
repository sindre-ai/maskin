-- Partial unique index: at most one active (starting/ready) auth-browser session
-- per workspace. Backstops the service-layer concurrency check against TOCTOU
-- races (React StrictMode double-mount firing two POSTs in parallel).

-- Clean up any pre-existing duplicates so the unique index can be created.
-- Keeps the most recent row per workspace active; flips siblings to 'expired'.
UPDATE "auth_browser_sessions" SET status = 'expired'
WHERE id IN (
	SELECT id FROM (
		SELECT id, ROW_NUMBER() OVER (
			PARTITION BY workspace_id
			ORDER BY created_at DESC
		) AS rn
		FROM "auth_browser_sessions"
		WHERE status IN ('starting', 'ready')
	) ranked
	WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_browser_sessions_ws_active_uniq"
ON "auth_browser_sessions" ("workspace_id")
WHERE status IN ('starting', 'ready');
