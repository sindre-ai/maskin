// Rate limiter for POST /mcp (task af90a015, MCP leftovers tech spec section 2).
//
// Pure logic: no Hono, no database, no env reads at import time. The route owns
// the wiring (identity lookup, client address, response shape); this file owns
// the numbers, so every rule can be tested with an injected clock.
//
// Shape: one token bucket per caller, capacity equal to one minute of refill.
// Agent and human callers are keyed by actor id (all sessions of one agent share
// a bucket). Callers that do not resolve to an actor are keyed by client address.
//
// Modes:
//   log-only (default)  nobody is rejected; a request over the limit is allowed
//                       and counted as would_reject, with the same accounting
//                       enforce uses, so a week of log-only data predicts enforce.
//   enforce             a request over the limit is rejected with a Retry-After.
//   off                 no accounting and no log.
//
// Storage is two bounded in-process maps (authenticated, unknown) with
// oldest-first eviction and a TTL sweep, the same discipline as
// lib/mcp-trace-seq.ts. They are separate so an unauthenticated flood can only
// ever evict unauthenticated entries. The state lives in this process, which is
// fine while apps/dev runs as one container; with replicas each would have its
// own buckets and the effective limit would multiply by the replica count.

import { logger as defaultLogger } from './logger'

export type RateLimitMode = 'log-only' | 'enforce' | 'off'
export type CallerClass = 'agent' | 'human' | 'unknown'

export interface RateLimitConfig {
	mode: RateLimitMode
	agentPerMin: number
	humanPerMin: number
	unknownPerMin: number
	writeCost: number
	exemptActorIds: ReadonlySet<string>
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	mode: 'log-only',
	agentPerMin: 600,
	humanPerMin: 120,
	unknownPerMin: 300,
	writeCost: 3,
	exemptActorIds: new Set(),
}

const PER_MIN_MIN = 1
const PER_MIN_MAX = 100_000
const WRITE_COST_MIN = 1
const WRITE_COST_MAX = 50

const AUTHED_CAP = 5_000
const UNKNOWN_CAP = 10_000
// A bucket idle for a full minute is back at capacity, exactly what a fresh one
// would hold, so dropping it loses nothing. The extra minute is margin.
const BUCKET_TTL_MS = 120_000

export const MIN_RETRY_AFTER_SECONDS = 1
export const MAX_RETRY_AFTER_SECONDS = 3_600
export const SUMMARY_INTERVAL_MS = 60_000
const TOP_ACTORS = 5
const TOP_ACTOR_TRACK_CAP = 1_000
const REJECT_LOG_TRACK_CAP = 1_000
const REJECT_LOG_INTERVAL_MS = 60_000

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Warn = (msg: string, context?: Record<string, unknown>) => void

// ── Config ──────────────────────────────────────────────────────────────

export function parseMode(raw: string | undefined, warn: Warn): RateLimitMode {
	const value = raw?.trim().toLowerCase()
	if (value === 'log-only' || value === 'enforce' || value === 'off') return value
	// Empty, missing or a typo. Falling back to enforce would reject real agents
	// on a mistake and falling back to off would hide it, so the safe middle is
	// log-only, said out loud once.
	warn('MASKIN_MCP_RATE_LIMIT_MODE is empty or not recognised, using log-only', {
		received_length: raw?.length ?? 0,
	})
	return 'log-only'
}

/** Integer in [min, max]; anything else (NaN, decimal, out of range) is the default. */
export function parseBoundedInt(
	name: string,
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
	warn: Warn,
): number {
	if (raw === undefined || raw.trim() === '') return fallback
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
		warn(`${name} is invalid, using the default`, { default: fallback, min, max })
		return fallback
	}
	return parsed
}

export function parseExemptActorIds(raw: string | undefined, warn: Warn): Set<string> {
	const ids = new Set<string>()
	if (!raw) return ids
	for (const entry of raw.split(',')) {
		const id = entry.trim()
		if (!id) continue
		if (!UUID_SHAPE.test(id)) {
			warn('MASKIN_MCP_RATE_LIMIT_EXEMPT_ACTOR_IDS rejected malformed entry', {
				entryLength: id.length,
			})
			continue
		}
		ids.add(id.toLowerCase())
	}
	return ids
}

export function resolveRateLimitConfig(
	env: NodeJS.ProcessEnv = process.env,
	warn: Warn = (msg, ctx) => defaultLogger.warn(msg, ctx),
): RateLimitConfig {
	const d = DEFAULT_RATE_LIMIT_CONFIG
	return {
		mode: parseMode(env.MASKIN_MCP_RATE_LIMIT_MODE, warn),
		agentPerMin: parseBoundedInt(
			'MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN',
			env.MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN,
			d.agentPerMin,
			PER_MIN_MIN,
			PER_MIN_MAX,
			warn,
		),
		humanPerMin: parseBoundedInt(
			'MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN',
			env.MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN,
			d.humanPerMin,
			PER_MIN_MIN,
			PER_MIN_MAX,
			warn,
		),
		unknownPerMin: parseBoundedInt(
			'MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN',
			env.MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN,
			d.unknownPerMin,
			PER_MIN_MIN,
			PER_MIN_MAX,
			warn,
		),
		writeCost: parseBoundedInt(
			'MASKIN_MCP_RATE_LIMIT_WRITE_COST',
			env.MASKIN_MCP_RATE_LIMIT_WRITE_COST,
			d.writeCost,
			WRITE_COST_MIN,
			WRITE_COST_MAX,
			warn,
		),
		exemptActorIds: parseExemptActorIds(env.MASKIN_MCP_RATE_LIMIT_EXEMPT_ACTOR_IDS, warn),
	}
}

/** The boot line. Counts and numbers only: no actor ids, no keys. */
export function describeConfig(config: RateLimitConfig): Record<string, unknown> {
	return {
		mode: config.mode,
		agent_per_min: config.agentPerMin,
		human_per_min: config.humanPerMin,
		unknown_per_min: config.unknownPerMin,
		write_cost: config.writeCost,
		exempt_actor_count: config.exemptActorIds.size,
	}
}

// ── Cost ────────────────────────────────────────────────────────────────

function asMessages(body: unknown): Array<Record<string, unknown>> {
	const list = Array.isArray(body) ? body : [body]
	return list.filter(
		(m): m is Record<string, unknown> => typeof m === 'object' && m !== null && !Array.isArray(m),
	)
}

export interface BodyCost {
	/** Tokens this HTTP request costs. At least 1. */
	cost: number
	/** Number of tools/call messages, for the summary. */
	toolCalls: number
}

/**
 * 1 per non-tool message, 1 per tools/call to a read tool, `writeCost` for any
 * other tools/call (deny by default: a call with no usable name is a write).
 * A batch sums its messages. Always at least 1, so an empty or junk body still
 * pays for the work of parsing it.
 */
export function costOfBody(
	body: unknown,
	readToolNames: ReadonlySet<string>,
	writeCost: number,
): BodyCost {
	let cost = 0
	let toolCalls = 0
	for (const message of asMessages(body)) {
		if (message.method !== 'tools/call') {
			cost += 1
			continue
		}
		toolCalls += 1
		const params = message.params
		const name =
			typeof params === 'object' && params !== null
				? (params as { name?: unknown }).name
				: undefined
		cost += typeof name === 'string' && readToolNames.has(name) ? 1 : writeCost
	}
	return { cost: Math.max(1, cost), toolCalls }
}

/**
 * The JSON-RPC ids a rejection must answer. A batch gets one entry per request
 * that has an id (notifications get no answer); a lone request, or a batch with
 * no id at all, gets a single null.
 */
export function rejectionIds(body: unknown): {
	batch: boolean
	ids: Array<string | number | null>
} {
	if (Array.isArray(body)) {
		const ids: Array<string | number | null> = []
		for (const message of asMessages(body)) {
			const id = message.id
			if ((typeof id === 'string' || typeof id === 'number') && message.method !== undefined) {
				ids.push(id)
			}
		}
		return ids.length > 0 ? { batch: true, ids } : { batch: false, ids: [null] }
	}
	const [single] = asMessages(body)
	const id = single?.id
	return { batch: false, ids: [typeof id === 'string' || typeof id === 'number' ? id : null] }
}

export const RATE_LIMIT_ERROR_CODE = -32029

export function buildRejectionBody(
	body: unknown,
	args: { retryAfterSeconds: number; limitPerMinute: number; callerClass: CallerClass },
) {
	const error = {
		code: RATE_LIMIT_ERROR_CODE,
		message: `Rate limit exceeded for this API key. Retry after ${args.retryAfterSeconds} seconds.`,
		data: {
			retry_after_seconds: args.retryAfterSeconds,
			limit_per_minute: args.limitPerMinute,
			class: args.callerClass,
		},
	}
	const { batch, ids } = rejectionIds(body)
	const answers = ids.map((id) => ({ jsonrpc: '2.0' as const, id, error }))
	return batch ? answers : answers[0]
}

// ── Limiter ─────────────────────────────────────────────────────────────

export type Outcome = 'allowed' | 'would_reject' | 'rejected' | 'exempt' | 'lookup_error'

export interface CheckInput {
	callerClass: CallerClass
	/** Actor id for agent and human; client address for unknown. */
	key: string
	/** Set for agent and human callers; used for the exempt list and the top-5. */
	actorId?: string
	cost: number
	toolCalls: number
	/** The request carried an Authorization key. */
	hadKey: boolean
}

export interface CheckResult {
	outcome: 'allowed' | 'would_reject' | 'rejected' | 'exempt'
	/** Whole seconds, 1 to 3600. Only set for would_reject and rejected. */
	retryAfterSeconds?: number
	limitPerMinute: number
}

interface Bucket {
	tokens: number
	at: number
}

interface ClassCounts {
	allowed: number
	would_reject: number
	rejected: number
	exempt: number
	lookup_error: number
}

const emptyCounts = (): ClassCounts => ({
	allowed: 0,
	would_reject: 0,
	rejected: 0,
	exempt: 0,
	lookup_error: 0,
})

export type SummaryPayload = Record<string, string | number | string[] | number[]>

export interface McpRateLimiterOptions {
	config: RateLimitConfig
	readToolNames: ReadonlySet<string>
	/** Injectable clock so tests can advance time without waiting. */
	now?: () => number
	log?: { info: Warn; warn: Warn }
}

export interface McpRateLimiter {
	readonly config: RateLimitConfig
	readonly readToolNames: ReadonlySet<string>
	check(input: CheckInput): CheckResult
	/** A lookup that errored: allow, and count it. Never touches a bucket. */
	recordLookupError(input: { toolCalls: number }): void
	/** Returns the summary for the window and resets it; null if there was no traffic. */
	flushSummary(): SummaryPayload | null
	/** Starts the 60 second summary interval (unref'd). A second call is a no-op. */
	startSummary(emit: (payload: SummaryPayload) => void): void
	/** Clears the interval. Safe to call twice. */
	stop(): void
	/** Buckets tracked per map, for tests and diagnostics. */
	sizes(): { authed: number; unknown: number }
	/** Whether the summary interval is currently running. */
	summaryRunning(): boolean
}

export function createMcpRateLimiter(options: McpRateLimiterOptions): McpRateLimiter {
	const { config, readToolNames } = options
	const now = options.now ?? Date.now
	const log = options.log ?? {
		info: (msg, ctx) => defaultLogger.info(msg, ctx),
		warn: (msg, ctx) => defaultLogger.warn(msg, ctx),
	}

	const authed = new Map<string, Bucket>()
	const unknown = new Map<string, Bucket>()

	let counts: Record<CallerClass, ClassCounts> = {
		agent: emptyCounts(),
		human: emptyCounts(),
		unknown: emptyCounts(),
	}
	let toolCallTotal = 0
	let unknownWithKey = 0
	let topActors = new Map<string, { would_reject: number; rejected: number }>()
	let windowStart = now()
	let sawTraffic = false

	const rejectLoggedAt = new Map<string, number>()
	let timer: ReturnType<typeof setInterval> | null = null

	const limitFor = (callerClass: CallerClass): number =>
		callerClass === 'agent'
			? config.agentPerMin
			: callerClass === 'human'
				? config.humanPerMin
				: config.unknownPerMin

	const sweep = (map: Map<string, Bucket>, t: number) => {
		for (const [key, bucket] of map) {
			if (t - bucket.at >= BUCKET_TTL_MS) map.delete(key)
		}
	}

	// Looks the bucket up FIRST: an existing caller never pays for making room.
	// Only a new caller can evict, and only inside its own map. The entry is
	// re-inserted on every touch so the Map's first key is the least recently
	// used one, which keeps a busy caller from being the eviction victim.
	const touch = (
		map: Map<string, Bucket>,
		cap: number,
		key: string,
		capacity: number,
		t: number,
	) => {
		const existing = map.get(key)
		if (existing) {
			map.delete(key)
			map.set(key, existing)
			return existing
		}
		if (map.size >= cap) {
			sweep(map, t)
			while (map.size >= cap) {
				const oldest = map.keys().next()
				if (oldest.done) break
				map.delete(oldest.value)
			}
		}
		const fresh: Bucket = { tokens: capacity, at: t }
		map.set(key, fresh)
		return fresh
	}

	const bumpActor = (actorId: string | undefined, field: 'would_reject' | 'rejected') => {
		if (!actorId) return
		let entry = topActors.get(actorId)
		if (!entry) {
			if (topActors.size >= TOP_ACTOR_TRACK_CAP) return
			entry = { would_reject: 0, rejected: 0 }
			topActors.set(actorId, entry)
		}
		entry[field] += 1
	}

	const logRejected = (input: CheckInput, limit: number, retryAfter: number, t: number) => {
		const trackKey = input.actorId ?? 'unknown'
		const last = rejectLoggedAt.get(trackKey)
		if (last !== undefined && t - last < REJECT_LOG_INTERVAL_MS) return
		if (rejectLoggedAt.size >= REJECT_LOG_TRACK_CAP) {
			for (const [k, at] of rejectLoggedAt) {
				if (t - at >= REJECT_LOG_INTERVAL_MS) rejectLoggedAt.delete(k)
			}
			if (rejectLoggedAt.size >= REJECT_LOG_TRACK_CAP) return
		}
		rejectLoggedAt.set(trackKey, t)
		log.warn('mcp_rate_limit_rejected', {
			actor_id: input.actorId ?? null,
			class: input.callerClass,
			cost: input.cost,
			limit_per_minute: limit,
			retry_after_seconds: retryAfter,
		})
	}

	const countTraffic = (toolCalls: number) => {
		sawTraffic = true
		toolCallTotal += toolCalls
	}

	const flushSummary = (): SummaryPayload | null => {
		const t = now()
		sweep(authed, t)
		sweep(unknown, t)
		if (!sawTraffic) {
			windowStart = t
			return null
		}
		const top = [...topActors.entries()]
			.sort((a, b) => b[1].would_reject + b[1].rejected - (a[1].would_reject + a[1].rejected))
			.slice(0, TOP_ACTORS)
			.filter(([, c]) => c.would_reject + c.rejected > 0)
		const payload: SummaryPayload = {
			mode: config.mode,
			window_seconds: Math.max(1, Math.round((t - windowStart) / 1000)),
			tool_calls: toolCallTotal,
			unknown_with_key: unknownWithKey,
			top_actor_ids: top.map(([id]) => id),
			top_actor_would_reject: top.map(([, c]) => c.would_reject),
			top_actor_rejected: top.map(([, c]) => c.rejected),
		}
		for (const callerClass of ['agent', 'human', 'unknown'] as const) {
			for (const [field, value] of Object.entries(counts[callerClass])) {
				payload[`${callerClass}_${field}`] = value
			}
		}
		counts = { agent: emptyCounts(), human: emptyCounts(), unknown: emptyCounts() }
		toolCallTotal = 0
		unknownWithKey = 0
		topActors = new Map()
		sawTraffic = false
		windowStart = t
		return payload
	}

	return {
		config,
		readToolNames,

		check(input) {
			const limit = limitFor(input.callerClass)
			if (config.mode === 'off') return { outcome: 'allowed', limitPerMinute: limit }

			const t = now()
			countTraffic(input.toolCalls)
			// A key was sent and did not resolve to an actor: a bad or revoked key.
			if (input.callerClass === 'unknown' && input.hadKey) unknownWithKey += 1
			const classCounts = counts[input.callerClass]

			if (input.actorId && config.exemptActorIds.has(input.actorId.toLowerCase())) {
				classCounts.exempt += 1
				return { outcome: 'exempt', limitPerMinute: limit }
			}

			const map = input.callerClass === 'unknown' ? unknown : authed
			const cap = input.callerClass === 'unknown' ? UNKNOWN_CAP : AUTHED_CAP
			const bucket = touch(map, cap, input.key, limit, t)

			// Refill: capacity is one minute of refill, so `limit` tokens per 60 s.
			const elapsed = Math.max(0, t - bucket.at)
			bucket.tokens = Math.min(limit, bucket.tokens + (elapsed * limit) / 60_000)
			bucket.at = t

			// A request dearer than the whole bucket could never be served; it is
			// priced at the bucket so it empties it instead of being refused forever.
			const cost = Math.min(input.cost, limit)

			if (bucket.tokens >= cost) {
				bucket.tokens -= cost
				classCounts.allowed += 1
				return { outcome: 'allowed', limitPerMinute: limit }
			}

			// Over the limit. Same accounting in both modes: nothing is consumed, so
			// a rejected request never makes the caller's next one costlier, and
			// log-only predicts enforce.
			const needed = cost - bucket.tokens
			const retryAfterSeconds = Math.min(
				MAX_RETRY_AFTER_SECONDS,
				Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil((needed * 60) / limit)),
			)
			if (config.mode === 'enforce') {
				classCounts.rejected += 1
				bumpActor(input.actorId, 'rejected')
				logRejected(input, limit, retryAfterSeconds, t)
				return { outcome: 'rejected', retryAfterSeconds, limitPerMinute: limit }
			}
			classCounts.would_reject += 1
			bumpActor(input.actorId, 'would_reject')
			return { outcome: 'would_reject', retryAfterSeconds, limitPerMinute: limit }
		},

		recordLookupError(input) {
			if (config.mode === 'off') return
			countTraffic(input.toolCalls)
			// The caller's class is unknown because the lookup failed, so the error is
			// counted under unknown. It is not an unknown_with_key: that is for keys
			// that did not resolve, and this one was never judged.
			counts.unknown.lookup_error += 1
		},

		flushSummary,

		startSummary(emit) {
			if (timer || config.mode === 'off') return
			timer = setInterval(() => {
				try {
					const payload = flushSummary()
					if (payload) emit(payload)
				} catch (err) {
					log.warn('mcp_rate_limit_summary failed', { error: String(err) })
				}
			}, SUMMARY_INTERVAL_MS)
			// The summary must never be what keeps the process alive.
			timer.unref?.()
		},

		stop() {
			if (timer) clearInterval(timer)
			timer = null
		},

		sizes() {
			return { authed: authed.size, unknown: unknown.size }
		},

		summaryRunning() {
			return timer !== null
		},
	}
}
