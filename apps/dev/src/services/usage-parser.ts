import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { parseResultLine } from '@maskin/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
	LEGACY_TOKENS_PER_USD_CENT,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
} from '../lib/llm-routing'
import { getModelPricing } from '../lib/openrouter-pricing'

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
 * Folds one turn's `result` envelope into the running usage of the CLI process
 * that emitted it. An interactive session writes one envelope per turn, and the
 * two kinds of number in it behave differently (measured against a live CLI over
 * two turns of one process): token counts and `duration_ms` are that turn's own,
 * so they are added up, while `total_cost_usd` is the process's running total,
 * so the newest value replaces the older one. Reading only the last envelope
 * would keep one turn's tokens and drop every earlier turn's.
 */
export function addTurnUsage(total: SessionUsage | null, turn: SessionUsage): SessionUsage {
	const add = (a: number | null | undefined, b: number | null): number | null =>
		a == null && b == null ? null : (a ?? 0) + (b ?? 0)
	return {
		totalCostUsd: turn.totalCostUsd ?? total?.totalCostUsd ?? null,
		inputTokens: add(total?.inputTokens, turn.inputTokens),
		outputTokens: add(total?.outputTokens, turn.outputTokens),
		cacheCreationInputTokens: add(total?.cacheCreationInputTokens, turn.cacheCreationInputTokens),
		cacheReadInputTokens: add(total?.cacheReadInputTokens, turn.cacheReadInputTokens),
		durationMs: add(total?.durationMs, turn.durationMs),
	}
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
	return parseUsageFromLogChunks(await readSessionStdoutChunks(db, sessionId))
}

/**
 * The newest stdout chunks of a session, oldest first — the one read that both
 * the usage parser and the failure classifier work from at completion. Callers
 * that need both should read once and share the result: each read pulls up to
 * `MAX_LOG_ROWS_FETCHED` rows (~4.6 KB each in production), and doing it twice
 * per completion was ~40% of database egress.
 *
 * Ordered by `id` (bigserial, monotonic) rather than `createdAt`, which can
 * tie at millisecond granularity and shuffle chunks within a tie.
 */
export async function readSessionStdoutChunks(db: Database, sessionId: string): Promise<string[]> {
	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(and(eq(sessionLogs.sessionId, sessionId), eq(sessionLogs.stream, 'stdout')))
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LOG_ROWS_FETCHED)

	// Rows came back newest-first; flip so chunks are in arrival order.
	return rows.map((r) => r.content).reverse()
}

/**
 * Token-only fallback for a session whose stdout holds no `result` envelope —
 * a non-interactive run killed at the wall-time ceiling never emits one, so the
 * result-based parse above returns null even though the session did real work.
 *
 * Sums the `usage` block of each top-level `assistant` message, counting every
 * message id once: stream-json emits one `assistant` line per content block and
 * repeats the message's usage on each, so the last line seen for an id wins.
 * Counting restarts after the last `result` envelope, because everything before
 * it was already accumulated by an earlier pause or turn.
 *
 * Cost and duration stay null on purpose — the CLI only reports cost on
 * `result`, and a token price guessed here would sit in the cost column with
 * nothing marking it as a guess. Returns null when no assistant usage is found.
 */
export function parseAssistantUsageFromLogChunks(chunks: string[]): SessionUsage | null {
	const byMessageId = new Map<string, Record<string, unknown>>()
	for (const line of chunks.join('').split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed[0] !== '{') continue
		if (parseResultLine(trimmed)) {
			byMessageId.clear()
			continue
		}
		let obj: Record<string, unknown>
		try {
			obj = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (!obj || obj.type !== 'assistant' || obj.parent_tool_use_id != null) continue
		const message = obj.message as { id?: unknown; usage?: unknown } | undefined
		if (typeof message?.id !== 'string' || !message.usage || typeof message.usage !== 'object') {
			continue
		}
		byMessageId.set(message.id, message.usage as Record<string, unknown>)
	}
	if (byMessageId.size === 0) return null

	const total = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
	for (const usage of byMessageId.values()) {
		total.input += finiteOrNull(usage.input_tokens) ?? 0
		total.output += finiteOrNull(usage.output_tokens) ?? 0
		total.cacheCreation += finiteOrNull(usage.cache_creation_input_tokens) ?? 0
		total.cacheRead += finiteOrNull(usage.cache_read_input_tokens) ?? 0
	}
	return {
		totalCostUsd: null,
		inputTokens: total.input,
		outputTokens: total.output,
		cacheCreationInputTokens: total.cacheCreation,
		cacheReadInputTokens: total.cacheRead,
		durationMs: null,
	}
}

/**
 * Runs `parseAssistantUsageFromLogChunks` over the session's stdout in
 * `session_logs`. `extractSessionUsage` reads only the newest 50 rows, which
 * cannot cover a session that ran for an hour, so this scans every row that
 * carries an `assistant` or `result` line (capped at the newest
 * `MAX_LIVE_RESULT_ROWS_FETCHED`).
 */
export async function sumAssistantUsage(
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
				sql`(${sessionLogs.content} LIKE '%"type":"assistant"%' OR ${sessionLogs.content} LIKE '%"type":"result"%')`,
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LIVE_RESULT_ROWS_FETCHED)
	return parseAssistantUsageFromLogChunks(rows.map((r) => r.content).reverse())
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

export interface SessionCostInput {
	/** The session's `config.llm_route` value. */
	route: string
	/** The session's `model_name`, when the route records one. */
	modelName: string | null
	usage: SessionUsage
}

/**
 * Resolves a session's true USD cost from its route and observed usage.
 *
 * The CLI prices every turn against Anthropic's rate card, which is correct
 * for the routes that actually reach Anthropic (`claude_oauth`, workspace API
 * keys) and wrong for `maskin_plan`, whose sessions are routed through
 * OpenRouter to a non-Anthropic model. For `maskin_plan` the reported
 * `total_cost_usd` is therefore discarded and the cost is computed locally
 * from token counts and OpenRouter's published per-token prices.
 *
 * Never returns a silent zero for real usage: when the model has no published
 * price (or no model name was recorded), it bills the tokens at the legacy
 * blended rate instead — conservative, and never Anthropic-scale for a
 * DeepSeek-priced session.
 *
 * `workspace_custom` (a BYO endpoint) is priced the same way, but only when its
 * model has a published price. The CLI cannot price a non-Anthropic model id
 * and reports a made-up figure (`costBasis: "unknown"`); an endpoint serving a
 * model OpenRouter does not list keeps the CLI figure, as there is nothing
 * better to bill against.
 */
export async function resolveSessionCostUsd({
	route,
	modelName,
	usage,
}: SessionCostInput): Promise<number | null> {
	if (route !== LLM_ROUTE_MASKIN_PLAN && route !== LLM_ROUTE_CUSTOM) return usage.totalCostUsd

	const inputTokens = usage.inputTokens ?? 0
	const outputTokens = usage.outputTokens ?? 0
	const cacheReadTokens = usage.cacheReadInputTokens ?? 0
	const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0

	if (modelName) {
		const pricing = await getModelPricing(modelName)
		if (pricing) {
			return (
				inputTokens * pricing.prompt +
				outputTokens * pricing.completion +
				cacheReadTokens * pricing.cacheRead +
				cacheWriteTokens * pricing.cacheWrite
			)
		}
	}

	if (route === LLM_ROUTE_CUSTOM) return usage.totalCostUsd

	// No priced model to bill against — fall back to the legacy blended rate.
	// Input + output tokens only, mirroring `getWorkspacePlanUsdCentsUsage`'s
	// estimate; cache reads are near-free and billing them at the blended rate
	// would over-charge. Cache-only usage still bills rather than reading as
	// $0, which would be the silent-zero this path exists to prevent.
	const tokens = inputTokens + outputTokens
	if (tokens > 0) return tokens / LEGACY_TOKENS_PER_USD_CENT / 100
	const cacheOnly = cacheReadTokens + cacheWriteTokens
	if (cacheOnly > 0) return cacheOnly / LEGACY_TOKENS_PER_USD_CENT / 100
	return null
}

/**
 * DB-backed equivalent of the in-memory `stdoutTail` for the remote path — a
 * microsandbox session's stdout only lands in `session_logs`. Stdout-only so
 * both completion paths classify from the same material. Ordered by `id`
 * (bigserial, monotonic) rather than `createdAt` — the latter ties within a
 * millisecond and shuffles chunks.
 */
export async function readSessionStdoutTail(db: Database, sessionId: string): Promise<string> {
	return (await readSessionStdoutChunks(db, sessionId)).join('')
}
