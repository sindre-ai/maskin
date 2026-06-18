#!/usr/bin/env node
// Print the seven parallelization-bet metrics for one window.
//
// Usage:
//   node scripts/metrics/parallelization-bet/run.mjs --workspace <uuid> [--window baseline|treatment|both]
//   node scripts/metrics/parallelization-bet/run.mjs --workspace <uuid> --start 2026-04-01 --end 2026-04-26
//
// Window presets (from the bet description):
//   baseline:  2026-04-01 → 2026-04-26  (pre-change)
//   treatment: 2026-04-26 → 2026-05-17  (three weeks post-change)
//
// Reads DATABASE_URL from env (or .env) — same shape as the dev backend uses.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const PRESETS = {
	baseline: { start: '2026-04-01T00:00:00Z', end: '2026-04-26T00:00:00Z' },
	treatment: { start: '2026-04-26T00:00:00Z', end: '2026-05-17T00:00:00Z' },
}

function loadDotenv() {
	try {
		const envPath = join(process.cwd(), '.env')
		const content = readFileSync(envPath, 'utf-8')
		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const idx = trimmed.indexOf('=')
			if (idx === -1) continue
			const key = trimmed.slice(0, idx)
			const value = trimmed.slice(idx + 1)
			if (!(key in process.env)) process.env[key] = value
		}
	} catch {}
}

function parseArgs(argv) {
	const args = { workspace: null, window: 'both', start: null, end: null, cap: null }
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		const next = argv[i + 1]
		if (a === '--workspace' || a === '-w') {
			args.workspace = next
			i++
		} else if (a === '--window') {
			args.window = next
			i++
		} else if (a === '--start') {
			args.start = next
			i++
		} else if (a === '--end') {
			args.end = next
			i++
		} else if (a === '--cap') {
			args.cap = Number(next)
			i++
		} else if (a === '--help' || a === '-h') {
			printHelp()
			process.exit(0)
		}
	}
	return args
}

function printHelp() {
	console.log(`Usage: run.mjs --workspace <uuid> [--window baseline|treatment|both] [--start ISO --end ISO] [--cap N]

  --workspace  workspace UUID to query (required)
  --window     baseline | treatment | both (default: both). Overridden by --start/--end.
  --start      ISO timestamp, inclusive
  --end        ISO timestamp, exclusive
  --cap        max_concurrent_sessions to compare against. Defaults to the live
               value read from workspaces.settings.

Reads DATABASE_URL from env or .env.`)
}

function resolveWindows(args) {
	if (args.start && args.end) {
		return [{ name: 'custom', start: args.start, end: args.end }]
	}
	if (args.window === 'baseline') return [{ name: 'baseline', ...PRESETS.baseline }]
	if (args.window === 'treatment') return [{ name: 'treatment', ...PRESETS.treatment }]
	return [
		{ name: 'baseline', ...PRESETS.baseline },
		{ name: 'treatment', ...PRESETS.treatment },
	]
}

function fmt(n) {
	if (n === null || n === undefined) return '—'
	if (typeof n === 'string') return n
	if (typeof n === 'bigint') return n.toString()
	if (typeof n === 'number') return Number.isInteger(n) ? n.toString() : n.toFixed(2)
	return String(n)
}

async function readWorkspaceCap(sql, workspaceId) {
	const rows = await sql`
		SELECT settings ->> 'max_concurrent_sessions' AS cap
		FROM workspaces
		WHERE id = ${workspaceId}
	`
	if (rows.length === 0) throw new Error(`workspace ${workspaceId} not found`)
	const raw = rows[0].cap
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 3
}

async function run() {
	loadDotenv()
	const args = parseArgs(process.argv)

	if (!args.workspace) {
		console.error('error: --workspace <uuid> is required')
		printHelp()
		process.exit(2)
	}
	if (!process.env.DATABASE_URL) {
		console.error('error: DATABASE_URL is not set (env or .env)')
		process.exit(2)
	}

	const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4 })

	try {
		const cap = args.cap ?? (await readWorkspaceCap(sql, args.workspace))
		const windows = resolveWindows(args)

		console.log(`workspace: ${args.workspace}`)
		console.log(`max_concurrent_sessions: ${cap}\n`)

		for (const w of windows) {
			console.log(`── ${w.name.toUpperCase()}  ${w.start} → ${w.end} ──`)
			const ws = args.workspace
			const s = w.start
			const e = w.end

			const cycle = await sql`
				WITH bet_completed AS (
					SELECT o.id, o.created_at AS proposed_at, MIN(ev.created_at) AS completed_at
					FROM objects o
					INNER JOIN events ev
						ON ev.entity_id = o.id
						AND ev.entity_type = 'bet'
						AND ev.action = 'status_changed'
						AND (ev.data -> 'updated' ->> 'status') IN ('completed', 'succeeded')
					WHERE o.type = 'bet' AND o.workspace_id = ${ws}
						AND ev.created_at >= ${s} AND ev.created_at < ${e}
					GROUP BY o.id, o.created_at
				)
				SELECT COUNT(*)::int AS bets_completed,
					ROUND((EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY completed_at - proposed_at)) / 3600)::numeric, 2) AS median_cycle_hours,
					ROUND((EXTRACT(EPOCH FROM AVG(completed_at - proposed_at)) / 3600)::numeric, 2) AS avg_cycle_hours
				FROM bet_completed
			`
			const c = cycle[0]
			console.log('  Bet cycle time:')
			console.log(`    bets_completed       = ${fmt(c.bets_completed)}`)
			console.log(`    median_cycle_hours   = ${fmt(c.median_cycle_hours)}`)
			console.log(`    avg_cycle_hours      = ${fmt(c.avg_cycle_hours)}`)

			const conc = await sql`
				WITH work_hour_buckets AS (
					SELECT ts FROM generate_series(${s}::timestamptz, ${e}::timestamptz, interval '5 minutes') AS ts
					WHERE EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
						AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16
				),
				concurrency AS (
					SELECT b.ts,
						(SELECT COUNT(*) FROM sessions ss
							WHERE ss.workspace_id = ${ws}
								AND ss.started_at IS NOT NULL
								AND ss.started_at <= b.ts
								AND (ss.completed_at IS NULL OR ss.completed_at > b.ts)) AS running
					FROM work_hour_buckets b
				)
				SELECT COUNT(*)::int AS samples,
					ROUND(AVG(running)::numeric, 2) AS avg_concurrent,
					ROUND(MAX(running)::numeric, 0)::int AS max_concurrent,
					ROUND((COUNT(*) FILTER (WHERE running >= ${cap}) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2) AS pct_at_cap
				FROM concurrency
			`
			const cc = conc[0]
			console.log('  Session concurrency (work hours, Mon-Fri 09:00-17:00 UTC):')
			console.log(`    samples              = ${fmt(cc.samples)}`)
			console.log(`    avg_concurrent       = ${fmt(cc.avg_concurrent)}`)
			console.log(`    max_concurrent       = ${fmt(cc.max_concurrent)}`)
			console.log(`    pct_at_cap (>= ${cap})  = ${fmt(cc.pct_at_cap)}%`)

			const merge = await sql`
				WITH merge_notifications AS (
					SELECT n.id, n.object_id FROM notifications n
					WHERE n.workspace_id = ${ws}
						AND n.created_at >= ${s} AND n.created_at < ${e}
						AND (n.title ILIKE '%merge%' OR n.title ILIKE '%awaiting%'
							OR n.type ILIKE '%merge%' OR n.type ILIKE '%review%')
				),
				notification_bet AS (
					SELECT mn.id AS notification_id,
						COALESCE(CASE WHEN o.type = 'bet' THEN o.id END, r.source_id) AS bet_id
					FROM merge_notifications mn
					LEFT JOIN objects o ON o.id = mn.object_id
					LEFT JOIN relationships r
						ON r.target_id = mn.object_id AND r.type = 'breaks_into'
				)
				SELECT COUNT(*)::int AS total_notifications,
					COUNT(DISTINCT bet_id) FILTER (WHERE bet_id IS NOT NULL)::int AS bets_with_notifications,
					ROUND((COUNT(*)::numeric / NULLIF(COUNT(DISTINCT bet_id) FILTER (WHERE bet_id IS NOT NULL), 0))::numeric, 2) AS avg_per_bet
				FROM notification_bet
			`
			const m = merge[0]
			console.log('  Awaiting-merge notifications:')
			console.log(`    total                = ${fmt(m.total_notifications)}`)
			console.log(`    bets_with_one+       = ${fmt(m.bets_with_notifications)}`)
			console.log(`    avg_per_bet          = ${fmt(m.avg_per_bet)}`)

			const rework = await sql`
				WITH tasks_in_window AS (
					SELECT id FROM objects
					WHERE type = 'task' AND workspace_id = ${ws}
						AND created_at >= ${s} AND created_at < ${e}
				),
				reworked AS (
					SELECT DISTINCT ev.entity_id FROM events ev
					WHERE ev.entity_type = 'task' AND ev.action = 'status_changed'
						AND ev.created_at >= ${s} AND ev.created_at < ${e}
						AND (ev.data -> 'previous' ->> 'status') = 'done'
						AND (ev.data -> 'updated' ->> 'status') = 'in_progress'
				)
				SELECT (SELECT COUNT(*) FROM tasks_in_window)::int AS total_tasks,
					(SELECT COUNT(*) FROM reworked)::int AS reworked_tasks,
					ROUND(((SELECT COUNT(*) FROM reworked)::numeric * 100.0
						/ NULLIF((SELECT COUNT(*) FROM tasks_in_window), 0))::numeric, 2) AS rework_pct
			`
			const r = rework[0]
			console.log('  Task rework rate:')
			console.log(`    total_tasks          = ${fmt(r.total_tasks)}`)
			console.log(`    reworked_tasks       = ${fmt(r.reworked_tasks)}`)
			console.log(`    rework_pct           = ${fmt(r.rework_pct)}%`)

			const edges = await sql`
				WITH bets_in_window AS (
					SELECT id FROM objects
					WHERE type = 'bet' AND workspace_id = ${ws}
						AND created_at >= ${s} AND created_at < ${e}
				),
				bet_tasks AS (
					SELECT bi.id AS bet_id, br.target_id AS task_id
					FROM bets_in_window bi
					INNER JOIN relationships br ON br.source_id = bi.id AND br.type = 'breaks_into'
				),
				bets_with_blocks AS (
					SELECT DISTINCT bt.bet_id FROM bet_tasks bt
					INNER JOIN relationships be ON be.type = 'blocks'
						AND (be.source_id = bt.task_id OR be.target_id = bt.task_id)
				)
				SELECT (SELECT COUNT(*) FROM bets_in_window)::int AS total_bets,
					(SELECT COUNT(*) FROM bets_with_blocks)::int AS bets_with_blocks_edge,
					ROUND(((SELECT COUNT(*) FROM bets_with_blocks)::numeric * 100.0
						/ NULLIF((SELECT COUNT(*) FROM bets_in_window), 0))::numeric, 2) AS coverage_pct
			`
			const ed = edges[0]
			console.log('  Edge coverage on new bets:')
			console.log(`    total_bets           = ${fmt(ed.total_bets)}`)
			console.log(`    bets_with_blocks     = ${fmt(ed.bets_with_blocks_edge)}`)
			console.log(`    coverage_pct         = ${fmt(ed.coverage_pct)}%`)

			const sweep = await sql`
				WITH sweep_trigger AS (
					SELECT id FROM triggers
					WHERE workspace_id = ${ws}
						AND (name ILIKE '%bet sweep%' OR name ILIKE '%daily bet%')
				),
				sweep_sessions AS (
					SELECT DATE_TRUNC('day', s2.created_at)::date AS day, COUNT(*)::int AS firings
					FROM sessions s2
					WHERE s2.workspace_id = ${ws}
						AND s2.trigger_id IN (SELECT id FROM sweep_trigger)
						AND s2.created_at >= ${s} AND s2.created_at < ${e}
					GROUP BY day
				)
				SELECT (SELECT COUNT(*) FROM sweep_trigger)::int AS sweep_triggers_found,
					COALESCE(SUM(firings), 0)::int AS total_firings,
					COUNT(*)::int AS days_with_firings,
					ROUND(COALESCE(AVG(firings), 0)::numeric, 2) AS avg_per_active_day
				FROM sweep_sessions
			`
			const sw = sweep[0]
			console.log('  Bet Sweep firings:')
			console.log(`    triggers_found       = ${fmt(sw.sweep_triggers_found)}`)
			console.log(`    total_firings        = ${fmt(sw.total_firings)}`)
			console.log(`    days_with_firings    = ${fmt(sw.days_with_firings)}`)
			console.log(`    avg_per_active_day   = ${fmt(sw.avg_per_active_day)}\n`)
		}
	} finally {
		await sql.end({ timeout: 5 })
	}
}

run().catch((err) => {
	console.error(err)
	process.exit(1)
})
