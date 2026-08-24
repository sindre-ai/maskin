import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { parseResultLine } from '@maskin/shared'
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

/**
 * Pure parser: scans log chunks (in arrival order) for the final
 * stream-json `result` event and extracts cost / token fields.
 *
 * Tolerates Docker multiplex splits (chunks may break a JSON line in
 * half) by joining first and splitting on newlines. Envelope recognition and
 * numeric coercion live in `parseResultLine` (@maskin/shared), which is
 * also what the interactive turn finalizer uses — one definition of "is
 * this a result envelope". Returns null if nothing found.
 */
export function parseUsageFromLogChunks(chunks: string[]): SessionUsage | null {
	if (chunks.length === 0) return null
	const lines = chunks.join('').split('\n')
	const start = Math.max(0, lines.length - MAX_LINES_SCANNED)
	for (let i = lines.length - 1; i >= start; i--) {
		const result = parseResultLine(lines[i] ?? '')
		if (result) return result.usage
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
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LOG_ROWS_FETCHED)

	if (rows.length === 0) return null
	// Rows came back newest-first; flip so chunks are in arrival order.
	// Order by `id` (bigserial, monotonic) rather than `createdAt`, which can
	// tie at millisecond granularity and shuffle chunks within a tie.
	const chunks = rows.map((r) => r.content).reverse()
	return parseUsageFromLogChunks(chunks)
}
