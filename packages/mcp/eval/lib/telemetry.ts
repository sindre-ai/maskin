import { MISFIRE_KINDS, type MisfireKind, type TelemetrySummary } from './types'

export interface TelemetryCountRow {
	event_type: string
	tool_name: string
	kind: string | null
	n: number
}

/** A postgres.js style tagged template. */
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>

export function emptyErrorsByKind(): Record<MisfireKind, number> {
	return Object.fromEntries(MISFIRE_KINDS.map((kind) => [kind, 0])) as Record<MisfireKind, number>
}

/**
 * Counting rules, from the staging runbook:
 *  - calls  = rows with event_type tool_call for the session id
 *  - errors = rows with event_type error, kind in data->>'kind'
 * A call that fails argument validation writes an error row and no tool_call
 * row, so the two are counted from different rows on purpose.
 */
export function summariseTelemetry(rows: TelemetryCountRow[]): TelemetrySummary {
	const summary: TelemetrySummary = {
		callCount: 0,
		errorsTotal: 0,
		errorsByKind: emptyErrorsByKind(),
		errorRowsByTool: {},
	}
	for (const row of rows) {
		if (row.event_type === 'tool_call') {
			summary.callCount += row.n
		} else if (row.event_type === 'error') {
			summary.errorsTotal += row.n
			summary.errorRowsByTool[row.tool_name] = (summary.errorRowsByTool[row.tool_name] ?? 0) + row.n
			if ((MISFIRE_KINDS as readonly string[]).includes(row.kind ?? '')) {
				summary.errorsByKind[row.kind as MisfireKind] += row.n
			}
		}
	}
	return summary
}

export async function readTelemetry(
	sql: Sql,
	workspaceId: string,
	sessionId: string,
): Promise<TelemetrySummary> {
	const rows = (await sql`
		select event_type, tool_name, data->>'kind' as kind, count(*)::int as n
		from mcp_telemetry
		where workspace_id = ${workspaceId} and session_id = ${sessionId}
		group by 1, 2, 3
	`) as TelemetryCountRow[]
	return summariseTelemetry(rows)
}

/**
 * Telemetry is posted fire-and-forget after the response is written, so the
 * last rows can land a moment after the agent has finished. Read until two
 * reads in a row agree, or give up after maxWaitMs and return the last read.
 */
export async function readSettledTelemetry(
	read: () => Promise<TelemetrySummary>,
	options: { intervalMs?: number; maxWaitMs?: number } = {},
): Promise<TelemetrySummary> {
	const intervalMs = options.intervalMs ?? 1000
	const maxWaitMs = options.maxWaitMs ?? 10000
	const deadline = Date.now() + maxWaitMs
	let previous = await read()
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
		const next = await read()
		if (JSON.stringify(next) === JSON.stringify(previous)) return next
		previous = next
	}
	return previous
}
