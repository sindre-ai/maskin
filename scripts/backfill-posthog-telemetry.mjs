// One-off backfill: copy the last 30 days of `mcp_telemetry` rows into PostHog
// via the `/capture/` endpoint so the Synthesizer can query historical signal
// through the PostHog MCP. Re-runs are safe within PostHog's 24h `$insert_id`
// dedupe window; rows older than that may double-count if replayed.
//
// Usage:
//   POSTHOG_PROJECT_KEY=phc_... \
//   POSTHOG_HOST=https://eu.i.posthog.com \  # optional; defaults to EU cloud
//   DATABASE_URL=postgres://... \
//   node scripts/backfill-posthog-telemetry.mjs
//
// Flags:
//   --days=N       Override the 30-day window (default 30).
//   --dry-run      Print event count + first event, skip the POST.

import { readFileSync } from 'node:fs'
import postgres from 'postgres'

function loadEnv() {
	try {
		const env = readFileSync('.env', 'utf-8')
		for (const line of env.split('\n')) {
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

loadEnv()

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const daysArg = args.find((a) => a.startsWith('--days='))
const rawDays = daysArg ? Number(daysArg.slice('--days='.length)) : 30
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL
const POSTHOG_PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY
const POSTHOG_HOST = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '')

if (!DATABASE_URL) {
	console.error('DATABASE_URL is required')
	process.exit(1)
}
if (!POSTHOG_PROJECT_KEY && !DRY_RUN) {
	console.error('POSTHOG_PROJECT_KEY is required (or pass --dry-run)')
	process.exit(1)
}

// PostHog `/capture/` accepts a batch payload of up to ~20MB. We chunk well
// under that so a single large `data` jsonb blob can't push a batch over.
const BATCH_SIZE = 500

const sql = postgres(DATABASE_URL, { prepare: false })

function buildEvent(row) {
	const eventName = `mcp_${row.event_type}`
	const properties = {
		tool_name: row.tool_name,
		workspace_id: row.workspace_id,
		session_id: row.session_id ?? undefined,
		duration_ms: row.duration_ms ?? undefined,
		has_rich_render: row.has_rich_render ?? undefined,
		object_type: row.object_type ?? undefined,
		mutation_kind: row.mutation_kind ?? undefined,
		// `$insert_id` is PostHog's 24h dedupe key — using the row id makes
		// re-runs of this backfill idempotent within that window.
		$insert_id: `mcp_telemetry_${row.id}`,
	}
	if (row.data && typeof row.data === 'object') {
		for (const [k, v] of Object.entries(row.data)) {
			if (!(k in properties)) properties[k] = v
		}
	}
	return {
		event: eventName,
		distinct_id: row.workspace_id,
		timestamp: new Date(row.created_at).toISOString(),
		properties,
	}
}

async function postBatch(batch) {
	const res = await fetch(`${POSTHOG_HOST}/capture/`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ api_key: POSTHOG_PROJECT_KEY, batch }),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		throw new Error(`PostHog /capture/ returned ${res.status}: ${body.slice(0, 500)}`)
	}
}

async function main() {
	const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
	console.log(
		`[backfill] reading mcp_telemetry rows since ${since.toISOString()} (${DAYS}d window)`,
	)

	const rows = await sql`
		SELECT id, workspace_id, event_type, tool_name, session_id,
		       has_rich_render, duration_ms, object_type, mutation_kind,
		       data, created_at
		FROM mcp_telemetry
		WHERE created_at >= ${since}
		ORDER BY created_at ASC
	`
	console.log(`[backfill] found ${rows.length} rows`)

	if (rows.length === 0) {
		await sql.end()
		return
	}

	const events = rows.map(buildEvent)

	if (DRY_RUN) {
		console.log('[backfill] dry-run — first event:')
		console.log(JSON.stringify(events[0], null, 2))
		await sql.end()
		return
	}

	let sent = 0
	for (let i = 0; i < events.length; i += BATCH_SIZE) {
		const batch = events.slice(i, i + BATCH_SIZE)
		await postBatch(batch)
		sent += batch.length
		console.log(`[backfill] posted ${sent}/${events.length} events`)
	}

	await sql.end()
	console.log(`[backfill] done — ${sent} events posted to ${POSTHOG_HOST}`)
}

main().catch(async (err) => {
	console.error('[backfill] failed:', err)
	try {
		await sql.end()
	} catch {}
	process.exit(1)
})
