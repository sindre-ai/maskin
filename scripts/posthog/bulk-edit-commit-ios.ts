/**
 * Runs the bet's ship-metric query against PostHog and prints
 * `avg(selected_count)` + event count for `bulk_edit_commit`
 * filtered to `platform_device = 'ios'` over a rolling 14 day window.
 *
 * Used by the Strategist's commitment-gate check on bet
 * `ios-bulk-select-ergonomics` after Sebastian's First-test traffic
 * lands. Rerunnable — no saved insight, no PostHog UI dependency.
 *
 * Required env:
 *   POSTHOG_PROJECT_ID         numeric project id (e.g. 191282)
 *   POSTHOG_PERSONAL_API_KEY   read-scoped Personal API Key — NOT
 *                              the project capture key in
 *                              `POSTHOG_API_KEY` (that's
 *                              write-only and can't query)
 * Optional:
 *   POSTHOG_HOST               defaults to https://eu.i.posthog.com
 *   WINDOW_DAYS                defaults to 14
 */

const DEFAULT_HOST = 'https://eu.i.posthog.com'

interface HogQLResponse {
	results?: Array<Array<unknown>>
	error?: string
	detail?: string
}

function required(name: string): string {
	const raw = process.env[name]?.trim()
	if (!raw) {
		console.error(`Missing required env var: ${name}`)
		process.exit(2)
	}
	return raw
}

function parseWindow(): number {
	const raw = process.env.WINDOW_DAYS?.trim()
	if (!raw) return 14
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) {
		console.error(`Invalid WINDOW_DAYS: ${raw}`)
		process.exit(2)
	}
	return Math.floor(n)
}

async function main(): Promise<void> {
	const projectId = required('POSTHOG_PROJECT_ID')
	const apiKey = required('POSTHOG_PERSONAL_API_KEY')
	const host = (process.env.POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/$/, '')
	const windowDays = parseWindow()

	// HogQL: PostHog stores `bulk_edit_commit` events in the `events` table.
	// `properties.selected_count` arrives as JSON; cast to Float64 for the average.
	// Filter to platform_device='ios' and the rolling N-day window.
	const query = `
SELECT
  count() AS event_count,
  avg(toFloat64OrNull(toString(properties.selected_count))) AS avg_selected_count
FROM events
WHERE event = 'bulk_edit_commit'
  AND properties.platform_device = 'ios'
  AND timestamp >= now() - INTERVAL ${windowDays} DAY
`.trim()

	const url = `${host}/api/projects/${encodeURIComponent(projectId)}/query/`
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
	})

	if (!res.ok) {
		const body = await res.text()
		console.error(`PostHog query failed: ${res.status} ${res.statusText}\n${body}`)
		process.exit(1)
	}

	const json = (await res.json()) as HogQLResponse
	if (json.error || !json.results) {
		console.error(`PostHog returned an error: ${json.error ?? json.detail ?? 'no results'}`)
		process.exit(1)
	}

	const row = json.results?.[0] ?? [0, null]
	const [eventCountRaw, avgRaw] = row
	const eventCount = Number(eventCountRaw) || 0
	const avg = avgRaw === null || avgRaw === undefined ? null : Number(avgRaw)

	console.log(`bulk_edit_commit (platform_device=ios, last ${windowDays}d)`)
	console.log(`  event_count        ${eventCount}`)
	console.log(`  avg(selected_count) ${avg === null ? 'n/a (no events)' : avg.toFixed(2)}`)
}

main().catch((err) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
	process.exit(1)
})
