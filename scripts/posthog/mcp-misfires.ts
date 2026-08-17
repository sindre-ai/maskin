/**
 * Weekly MCP misfire cluster report.
 * Queries PostHog for mcp_misfire_* events over the last 7 days,
 * clusters by (tool_name, requested_shape), and prints JSON results.
 *
 * Required env:
 *   POSTHOG_API_KEY         project API key (capture key, eu project 191282)
 *                           OR
 *   POSTHOG_PERSONAL_API_KEY read-scoped personal API key (preferred for HogQL)
 *   POSTHOG_PROJECT_ID       numeric project id (default: 191282)
 * Optional:
 *   POSTHOG_HOST             defaults to https://eu.i.posthog.com
 */

const DEFAULT_HOST = 'https://eu.i.posthog.com'
const DEFAULT_PROJECT_ID = '191282'

interface HogQLResponse {
	results?: Array<Array<unknown>>
	columns?: string[]
	error?: string
	detail?: string
}

export interface MisfireCluster {
	event: string
	tool_name: string
	requested_shape: string
	count: number
}

function getApiKey(): string {
	const personal = process.env.POSTHOG_PERSONAL_API_KEY?.trim()
	if (personal) return personal
	const project = process.env.POSTHOG_API_KEY?.trim()
	if (project) return project
	console.error('Missing required env var: POSTHOG_PERSONAL_API_KEY or POSTHOG_API_KEY')
	process.exit(2)
}

async function main(): Promise<void> {
	const apiKey = getApiKey()
	const projectId = (process.env.POSTHOG_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID)
	const host = (process.env.POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/$/, '')

	const query = `
SELECT
  event,
  properties.tool_name AS tool_name,
  properties.requested_shape AS requested_shape,
  count() AS cnt
FROM events
WHERE event IN ('mcp_misfire_tool_not_found', 'mcp_misfire_unknown_param', 'mcp_misfire_schema_validation_error')
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY event, properties.tool_name, properties.requested_shape
ORDER BY cnt DESC
LIMIT 200
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
		console.error(`PostHog returned an error: ${json.error ?? json.detail ?? 'no results field'}`)
		process.exit(1)
	}

	const clusters: MisfireCluster[] = json.results.map((row) => ({
		event: String(row[0] ?? ''),
		tool_name: String(row[1] ?? ''),
		requested_shape: String(row[2] ?? ''),
		count: Number(row[3]) || 0,
	}))

	const totals: Record<string, number> = {}
	for (const c of clusters) {
		totals[c.event] = (totals[c.event] ?? 0) + c.count
	}

	console.log(JSON.stringify({ clusters, totals }, null, 2))
}

main().catch((err) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
	process.exit(1)
})
