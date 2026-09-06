import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { parseResultLine } from '@maskin/shared'
import { and, desc, eq, sql } from 'drizzle-orm'

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
const MAX_LIVE_RESULT_ROWS_FETCHED = 2000

// Local to `sumRunningSessionUsage` below, which sums raw `result` envelopes
// itself rather than going through `parseResultLine`.
const finiteOrNull = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : null
}

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

/**
 * Best-effort LIVE usage scan for a still-running session: sums *every*
 * `result` event seen so far, not just the last one — an interactive
 * session emits one `result` per turn, and a still-running session may
 * already be many turns in. This backs mid-session budget enforcement (a
 * long interactive session must be stoppable before it exhausts a
 * workspace's credit balance, not just checked once at dispatch), not
 * final billing — `extractSessionUsage`/`parseUsageFromLogChunks` remain
 * the source of truth once the session actually pauses or completes.
 *
 * Re-scans from scratch on every call rather than tracking a durable
 * watermark: simpler, can't under-count across a process restart, and
 * cheap relative to the ~60s cadence this is called at. The `LIKE` filter
 * keeps the query from pulling large non-result chunks (tool output can be
 * substantial); the tradeoff is a `result` line split exactly across two
 * log rows at the filter boundary would be missed — acceptable for a
 * safety net re-evaluated every tick, not the final debit computation.
 * Returns null when no `result` events are found yet.
 */
export async function sumRunningSessionUsage(
	db: Database,
	sessionId: string,
): Promise<SessionUsage | null> {
	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				eq(sessionLogs.stream, 'stdout'),
				sql`${sessionLogs.content} LIKE '%"type":"result"%'`,
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LIVE_RESULT_ROWS_FETCHED)

	if (rows.length === 0) return null
	const lines = rows
		.map((r) => r.content)
		.reverse()
		.join('\n')
		.split('\n')

	let totalInput = 0
	let totalOutput = 0
	let totalCost = 0
	let totalCacheCreate = 0
	let totalCacheRead = 0
	let totalDuration = 0
	let found = false

	for (const raw of lines) {
		const line = raw.trim()
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
		found = true
		totalInput += finiteOrNull(usage.input_tokens) ?? 0
		totalOutput += finiteOrNull(usage.output_tokens) ?? 0
		totalCost += finiteOrNull(obj.total_cost_usd) ?? 0
		totalCacheCreate += finiteOrNull(usage.cache_creation_input_tokens) ?? 0
		totalCacheRead += finiteOrNull(usage.cache_read_input_tokens) ?? 0
		totalDuration += finiteOrNull(obj.duration_ms) ?? 0
	}

	if (!found) return null
	return {
		totalCostUsd: totalCost,
		inputTokens: totalInput,
		outputTokens: totalOutput,
		cacheCreationInputTokens: totalCacheCreate,
		cacheReadInputTokens: totalCacheRead,
		durationMs: totalDuration,
	}
}

/**
 * DB-backed equivalent of the in-memory `stdoutTail` for the remote path — a
 * microsandbox session's stdout only lands in `session_logs`. Stdout-only so
 * both completion paths classify from the same material. Ordered by `id`
 * (bigserial, monotonic) rather than `createdAt` — the latter ties within a
 * millisecond and shuffles chunks.
 */
export async function readSessionStdoutTail(db: Database, sessionId: string): Promise<string> {
	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(and(eq(sessionLogs.sessionId, sessionId), eq(sessionLogs.stream, 'stdout')))
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LOG_ROWS_FETCHED)

	return rows
		.map((r) => r.content)
		.reverse()
		.join('')
}
