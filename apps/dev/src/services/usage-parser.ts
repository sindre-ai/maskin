import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { parseResultLine } from '@maskin/shared'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
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

// Local to `parseAssistantUsageFromLogChunks` below, which reads raw `usage` blocks
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
 * Sums every top-level `result` envelope in the chunks into one segment total.
 *
 * An interactive session emits one `result` per turn, and the CLI reports the
 * token counts and `duration_ms` for that turn alone while `total_cost_usd`
 * runs cumulatively across the process (checked against Claude Code 2.1.285
 * with two turns in one process). So tokens and duration are added up and the
 * cost is the last figure seen. Reading only the last envelope, as
 * `parseUsageFromLogChunks` does, keeps one turn's tokens for a whole chat.
 * Returns null when no envelope is found.
 */
export function sumResultUsageFromLogChunks(chunks: string[]): SessionUsage | null {
	const total: SessionUsage = {
		totalCostUsd: null,
		inputTokens: null,
		outputTokens: null,
		cacheCreationInputTokens: null,
		cacheReadInputTokens: null,
		durationMs: null,
	}
	const add = (sum: number | null, next: number | null) => (next === null ? sum : (sum ?? 0) + next)
	let found = false
	for (const line of chunks.join('').split('\n')) {
		const result = parseResultLine(line)
		if (!result) continue
		found = true
		const { usage } = result
		total.totalCostUsd = usage.totalCostUsd ?? total.totalCostUsd
		total.inputTokens = add(total.inputTokens, usage.inputTokens)
		total.outputTokens = add(total.outputTokens, usage.outputTokens)
		total.cacheCreationInputTokens = add(
			total.cacheCreationInputTokens,
			usage.cacheCreationInputTokens,
		)
		total.cacheReadInputTokens = add(total.cacheReadInputTokens, usage.cacheReadInputTokens)
		total.durationMs = add(total.durationMs, usage.durationMs)
	}
	return found ? total : null
}

/** System log written when a paused session is relaunched, which starts a new CLI process. */
export const SESSION_RESUMED_LOG = 'Session resumed from snapshot'

/**
 * Usage of the session's current CLI process, summed over all its turns (see
 * `sumResultUsageFromLogChunks`). A pause saves its segment's usage and the
 * resume launches a fresh process, so only `result` lines after the latest
 * resume marker belong to this segment; counting earlier ones would add the
 * paused segment a second time. Reads every row that carries a `result`
 * envelope, capped at the newest `MAX_LIVE_RESULT_ROWS_FETCHED`. The usage
 * block sits after the result text, so a long reply that splits across rows
 * keeps its tail through the `total_cost_usd` match.
 */
export async function sumSegmentResultUsage(
	db: Database,
	sessionId: string,
): Promise<SessionUsage | null> {
	const [marker] = await db
		.select({ id: sessionLogs.id })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				eq(sessionLogs.stream, 'system'),
				eq(sessionLogs.content, SESSION_RESUMED_LOG),
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(1)

	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				eq(sessionLogs.stream, 'stdout'),
				marker ? gt(sessionLogs.id, marker.id) : undefined,
				sql`(${sessionLogs.content} LIKE '%"type":"result"%' OR ${sessionLogs.content} LIKE '%"total_cost_usd"%')`,
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LIVE_RESULT_ROWS_FETCHED)
	return sumResultUsageFromLogChunks(rows.map((r) => r.content).reverse())
}

/** What the session's usage columns already hold, as recorded on the row. */
export interface UsageWatermark {
	/** Newest `session_logs.id` whose `result` envelope is already counted; null = none. */
	logId: number | null
	/** The CLI's cumulative `total_cost_usd` for the current process at that point. */
	cliCost: number | null
}

export interface UncountedUsage {
	/** Tokens/duration added up over the uncounted results; `totalCostUsd` is the cost INCREMENT. */
	usage: SessionUsage
	/** Move the watermark here once `usage` is saved. */
	watermark: { logId: number; cliCost: number }
}

/**
 * Sums the `result` envelopes the session's usage columns do not hold yet.
 *
 * A per-turn write and every settle path call this and then advance the
 * watermark in the same UPDATE that adds the usage, so each envelope is added
 * exactly once however the writers interleave. Only envelopes after the latest
 * resume marker count for the cost base: a resume starts a new CLI process whose
 * cumulative `total_cost_usd` restarts from zero, so the stored `cliCost` is
 * ignored once a marker sits after the watermark.
 *
 * Tokens and duration are per turn, so they are summed. The cost is cumulative
 * per process, so the increment is the last figure seen minus the base.
 * Returns null when no new envelope is found.
 */
export async function sumUncountedResultUsage(
	db: Database,
	sessionId: string,
	watermark: UsageWatermark,
): Promise<UncountedUsage | null> {
	const [marker] = await db
		.select({ id: sessionLogs.id })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				eq(sessionLogs.stream, 'system'),
				eq(sessionLogs.content, SESSION_RESUMED_LOG),
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(1)

	const countedId = watermark.logId ?? 0
	const sameProcess = watermark.logId !== null && (!marker || marker.id < watermark.logId)
	const lowerBound = Math.max(marker?.id ?? 0, countedId)
	const baseCost = sameProcess ? (watermark.cliCost ?? 0) : 0

	const rows = await db
		.select({ id: sessionLogs.id, content: sessionLogs.content })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				eq(sessionLogs.stream, 'stdout'),
				gt(sessionLogs.id, lowerBound),
				sql`(${sessionLogs.content} LIKE '%"type":"result"%' OR ${sessionLogs.content} LIKE '%"total_cost_usd"%')`,
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(MAX_LIVE_RESULT_ROWS_FETCHED)

	// Walk oldest first, remembering the row each complete envelope ended in: the
	// watermark must never move past the first half of an envelope split across rows.
	const ordered = rows.reverse()
	let buffer = ''
	let throughLogId: number | null = null
	let lastCost: number | null = null
	const found: string[] = []
	for (const row of ordered) {
		buffer += row.content
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of [...lines, ...(parseResultLine(buffer) ? [buffer] : [])]) {
			if (!parseResultLine(line)) continue
			found.push(line)
			throughLogId = row.id
		}
		if (parseResultLine(buffer)) buffer = ''
	}
	if (found.length === 0 || throughLogId === null) return null

	const summed = sumResultUsageFromLogChunks(found.map((l) => `${l}\n`))
	if (!summed) return null
	lastCost = summed.totalCostUsd
	const cliCostAfter = lastCost ?? baseCost
	return {
		usage: {
			...summed,
			totalCostUsd: lastCost === null ? null : Math.max(0, lastCost - baseCost),
		},
		watermark: { logId: throughLogId, cliCost: cliCostAfter },
	}
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
