-- Parallelization bet metric queries.
--
-- Bet: "Parallelize agent pipeline — remove human-in-the-loop merge gate"
--   Baseline window:  Apr 1 2026 – Apr 26 2026 (pre-change)
--   Treatment window: Apr 26 2026 – May 17 2026 (three weeks post-change)
--
-- Every query takes the same three positional parameters:
--   $1  uuid       workspace_id
--   $2  timestamptz window_start (inclusive)
--   $3  timestamptz window_end   (exclusive)
-- A few queries take an extra param (documented inline).
--
-- Run a single query with psql:
--   psql "$DATABASE_URL" -v ws="'<workspace_id>'" -v start="'2026-04-01'" -v end="'2026-04-26'" \
--     -f queries.sql
-- Or use scripts/metrics/parallelization-bet/run.mjs to print all metrics for a window.

-- ─── PRIMARY 1: Bet cycle time ────────────────────────────────────────────────
-- Median + average time from bet creation (proposed) to first transition into
-- a terminal status (`completed` or `succeeded`). Bets that completed inside
-- the window count once.
-- name: bet_cycle_time
WITH bet_completed AS (
	SELECT
		o.id,
		o.created_at AS proposed_at,
		MIN(e.created_at) AS completed_at
	FROM objects o
	INNER JOIN events e
		ON e.entity_id = o.id
		AND e.entity_type = 'bet'
		AND e.action = 'status_changed'
		AND (e.data -> 'updated' ->> 'status') IN ('completed', 'succeeded')
	WHERE o.type = 'bet'
		AND o.workspace_id = $1
		AND e.created_at >= $2
		AND e.created_at < $3
	GROUP BY o.id, o.created_at
)
SELECT
	COUNT(*) AS bets_completed,
	ROUND(
		(EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY completed_at - proposed_at)) / 3600)::numeric,
		2
	) AS median_cycle_hours,
	ROUND((EXTRACT(EPOCH FROM AVG(completed_at - proposed_at)) / 3600)::numeric, 2) AS avg_cycle_hours
FROM bet_completed;

-- ─── PRIMARY 2 + 3: Concurrent sessions during work hours ────────────────────
-- Samples session concurrency at 5-minute intervals across the window, keeping
-- only buckets that fall in Mon–Fri 09:00–17:00 UTC. Returns:
--   - avg concurrent running sessions
--   - % of sampled work-hour buckets where running >= max_concurrent_sessions
-- Extra param:
--   $4  int  max_concurrent_sessions (read from workspaces.settings before running)
-- name: session_concurrency
WITH work_hour_buckets AS (
	SELECT ts
	FROM generate_series($2::timestamptz, $3::timestamptz, interval '5 minutes') AS ts
	WHERE EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
		AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16
),
concurrency AS (
	SELECT
		b.ts,
		(
			SELECT COUNT(*)
			FROM sessions s
			WHERE s.workspace_id = $1
				AND s.started_at IS NOT NULL
				AND s.started_at <= b.ts
				AND (s.completed_at IS NULL OR s.completed_at > b.ts)
		) AS running
	FROM work_hour_buckets b
)
SELECT
	COUNT(*) AS samples,
	ROUND(AVG(running)::numeric, 2) AS avg_concurrent,
	ROUND(MAX(running)::numeric, 0) AS max_concurrent,
	ROUND(
		(COUNT(*) FILTER (WHERE running >= $4) * 100.0 / NULLIF(COUNT(*), 0))::numeric,
		2
	) AS pct_at_cap
FROM concurrency;

-- ─── SECONDARY 1: 'Awaiting merge' notifications per bet ─────────────────────
-- Heuristic — counts notifications in the window whose title/type references
-- merging or review-readiness, attributing them to the bet the notification's
-- object_id belongs to (either the bet itself or a task that breaks_into a bet).
-- Note: notification copy is product-controlled; if the wording shifts, update
-- the ILIKE list below.
-- name: awaiting_merge_notifications
WITH merge_notifications AS (
	SELECT n.id, n.object_id
	FROM notifications n
	WHERE n.workspace_id = $1
		AND n.created_at >= $2
		AND n.created_at < $3
		AND (
			n.title ILIKE '%merge%'
			OR n.title ILIKE '%awaiting%'
			OR n.type ILIKE '%merge%'
			OR n.type ILIKE '%review%'
		)
),
notification_bet AS (
	SELECT
		mn.id AS notification_id,
		COALESCE(
			CASE WHEN o.type = 'bet' THEN o.id END,
			r.source_id
		) AS bet_id
	FROM merge_notifications mn
	LEFT JOIN objects o ON o.id = mn.object_id
	LEFT JOIN relationships r
		ON r.target_id = mn.object_id
		AND r.source_type = 'object'
		AND r.target_type = 'task'
		AND r.type = 'breaks_into'
)
SELECT
	COUNT(*) AS total_notifications,
	COUNT(DISTINCT bet_id) FILTER (WHERE bet_id IS NOT NULL) AS bets_with_notifications,
	ROUND(
		(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT bet_id) FILTER (WHERE bet_id IS NOT NULL), 0))::numeric,
		2
	) AS avg_per_bet
FROM notification_bet;

-- ─── SECONDARY 2: Task rework rate ───────────────────────────────────────────
-- A task is "reworked" if it ever transitioned from status `done` back to
-- `in_progress`. Rate = reworked / total tasks created in window.
-- name: task_rework_rate
WITH tasks_in_window AS (
	SELECT id
	FROM objects
	WHERE type = 'task'
		AND workspace_id = $1
		AND created_at >= $2
		AND created_at < $3
),
reworked AS (
	SELECT DISTINCT e.entity_id
	FROM events e
	WHERE e.entity_type = 'task'
		AND e.action = 'status_changed'
		AND e.created_at >= $2
		AND e.created_at < $3
		AND (e.data -> 'previous' ->> 'status') = 'done'
		AND (e.data -> 'updated' ->> 'status') = 'in_progress'
)
SELECT
	(SELECT COUNT(*) FROM tasks_in_window) AS total_tasks,
	(SELECT COUNT(*) FROM reworked) AS reworked_tasks,
	ROUND(
		((SELECT COUNT(*) FROM reworked)::numeric * 100.0
		/ NULLIF((SELECT COUNT(*) FROM tasks_in_window), 0))::numeric,
		2
	) AS rework_pct;

-- ─── SECONDARY 3: Edge coverage on new bets ──────────────────────────────────
-- % of bets created in the window that have at least one `blocks` edge between
-- their tasks. Approximation of "bets whose dependencies are materialized as
-- edges" — does not validate that prose dependencies are fully captured.
-- Pair this with manual review of the first 3–4 newly planned bets (per the
-- bet's risks section).
-- name: edge_coverage
WITH bets_in_window AS (
	SELECT id
	FROM objects
	WHERE type = 'bet'
		AND workspace_id = $1
		AND created_at >= $2
		AND created_at < $3
),
bet_tasks AS (
	SELECT bi.id AS bet_id, br.target_id AS task_id
	FROM bets_in_window bi
	INNER JOIN relationships br
		ON br.source_id = bi.id
		AND br.type = 'breaks_into'
),
bets_with_blocks AS (
	SELECT DISTINCT bt.bet_id
	FROM bet_tasks bt
	INNER JOIN relationships blocks_edge
		ON blocks_edge.type = 'blocks'
		AND (blocks_edge.source_id = bt.task_id OR blocks_edge.target_id = bt.task_id)
)
SELECT
	(SELECT COUNT(*) FROM bets_in_window) AS total_bets,
	(SELECT COUNT(*) FROM bets_with_blocks) AS bets_with_blocks_edge,
	ROUND(
		((SELECT COUNT(*) FROM bets_with_blocks)::numeric * 100.0
		/ NULLIF((SELECT COUNT(*) FROM bets_in_window), 0))::numeric,
		2
	) AS coverage_pct;

-- ─── SECONDARY 4: Daily Bet Sweep firings ────────────────────────────────────
-- Counts trigger-driven sessions whose trigger name matches "Bet Sweep" (or
-- variants). A fired Bet Sweep means the orchestrator failed to auto-advance
-- something — should approach zero as fan-out matures.
-- name: bet_sweep_firings
WITH sweep_trigger AS (
	SELECT id, name
	FROM triggers
	WHERE workspace_id = $1
		AND (name ILIKE '%bet sweep%' OR name ILIKE '%daily bet%')
),
sweep_sessions AS (
	SELECT DATE_TRUNC('day', s.created_at)::date AS day, COUNT(*) AS firings
	FROM sessions s
	WHERE s.workspace_id = $1
		AND s.trigger_id IN (SELECT id FROM sweep_trigger)
		AND s.created_at >= $2
		AND s.created_at < $3
	GROUP BY day
)
SELECT
	(SELECT COUNT(*) FROM sweep_trigger) AS sweep_triggers_found,
	COALESCE(SUM(firings), 0) AS total_firings,
	COUNT(*) AS days_with_firings,
	ROUND(COALESCE(AVG(firings), 0)::numeric, 2) AS avg_per_active_day
FROM sweep_sessions;
