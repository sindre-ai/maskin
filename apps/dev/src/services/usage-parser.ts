import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'

export type SessionUsage = {
	totalCostUsd: number | null
	inputTokens: number | null
	outputTokens: number | null
	cacheCreationInputTokens: number | null
	cacheReadInputTokens: number | null
	durationMs: number | null
}

const MAX_LINES_SCANNED = 200
const MAX_LOG_ROWS_FETCHED = 50

const finiteOrNull = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : null
}

/**
 * Pure parser: scans log chunks (in arrival order) for the final
 * stream-json `result` event and extracts cost / token fields.
 *
 * Tolerates Docker multiplex splits (chunks may break a JSON line in
 * half) by joining first and splitting on '\n'. Tolerates non-JSON
 * noise via per-line try/catch. Returns null if nothing found.
 */
export function parseUsageFromLogChunks(chunks: string[]): SessionUsage | null {
	if (chunks.length === 0) return null
	const lines = chunks.join('').split('\n')
	const start = Math.max(0, lines.length - MAX_LINES_SCANNED)
	for (let i = lines.length - 1; i >= start; i--) {
		const line = lines[i]?.trim()
		if (!line || line[0] !== '{') continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			continue
		}
		if (!parsed || typeof parsed !== 'object') continue
		const obj = parsed as Record<string, unknown>
		if (obj.type !== 'result') continue
		const usage = (obj.usage ?? {}) as Record<string, unknown>
		return {
			totalCostUsd: finiteOrNull(obj.total_cost_usd),
			inputTokens: finiteOrNull(usage.input_tokens),
			outputTokens: finiteOrNull(usage.output_tokens),
			cacheCreationInputTokens: finiteOrNull(usage.cache_creation_input_tokens),
			cacheReadInputTokens: finiteOrNull(usage.cache_read_input_tokens),
			durationMs: finiteOrNull(obj.duration_ms),
		}
	}
	return null
}

/**
 * Reads the tail of stdout from session_logs and parses it for the
 * final stream-json `result` event. Returns null when nothing useful
 * is found — e.g. Codex / custom runtimes that don't emit structured
 * usage. Never throws on parse failure; only DB errors propagate.
 */
export async function extractSessionUsage(
	db: Database,
	sessionId: string,
): Promise<SessionUsage | null> {
	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(and(eq(sessionLogs.sessionId, sessionId), eq(sessionLogs.stream, 'stdout')))
		.orderBy(desc(sessionLogs.createdAt))
		.limit(MAX_LOG_ROWS_FETCHED)

	if (rows.length === 0) return null
	// Rows came back newest-first; flip so chunks are in arrival order.
	const chunks = rows.map((r) => r.content).reverse()
	return parseUsageFromLogChunks(chunks)
}
