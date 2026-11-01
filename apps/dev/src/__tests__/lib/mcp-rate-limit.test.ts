import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_RATE_LIMIT_CONFIG,
	type RateLimitConfig,
	buildRejectionBody,
	costOfBody,
	createMcpRateLimiter,
	describeConfig,
	parseExemptActorIds,
	parseMode,
	resolveRateLimitConfig,
} from '../../lib/mcp-rate-limit'

const READ = new Set(['get_objects', 'list_objects'])
const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'

function makeLimiter(overrides: Partial<RateLimitConfig> = {}) {
	let t = 1_000_000
	const log = { info: vi.fn(), warn: vi.fn() }
	const limiter = createMcpRateLimiter({
		config: { ...DEFAULT_RATE_LIMIT_CONFIG, mode: 'enforce', ...overrides },
		readToolNames: READ,
		now: () => t,
		log,
	})
	return {
		limiter,
		log,
		advance: (ms: number) => {
			t += ms
		},
	}
}

const agent = (cost = 1, key = ACTOR_A) => ({
	callerClass: 'agent' as const,
	key,
	actorId: key,
	cost,
	toolCalls: 0,
	hadKey: true,
})
const stranger = (key = '203.0.113.7', cost = 1, hadKey = false) => ({
	callerClass: 'unknown' as const,
	key,
	cost,
	toolCalls: 0,
	hadKey,
})

describe('costOfBody', () => {
	const cost = (body: unknown) => costOfBody(body, READ, 3)

	it('charges 1 for non-tool messages', () => {
		expect(cost({ jsonrpc: '2.0', id: 1, method: 'initialize' }).cost).toBe(1)
		expect(cost({ jsonrpc: '2.0', method: 'notifications/initialized' }).cost).toBe(1)
		expect(cost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).cost).toBe(1)
	})

	it('charges 1 for a read tool and the write cost for any other tool', () => {
		const call = (name: unknown) => ({ method: 'tools/call', id: 1, params: { name } })
		expect(cost(call('get_objects'))).toEqual({ cost: 1, toolCalls: 1 })
		expect(cost(call('create_objects'))).toEqual({ cost: 3, toolCalls: 1 })
		// Deny by default: no usable name is a write.
		expect(cost(call(undefined)).cost).toBe(3)
		expect(cost({ method: 'tools/call', id: 1 }).cost).toBe(3)
	})

	it('sums a batch and never charges less than 1', () => {
		const batch = [
			{ method: 'tools/call', id: 1, params: { name: 'list_objects' } },
			{ method: 'tools/call', id: 2, params: { name: 'update_objects' } },
			{ method: 'ping', id: 3 },
		]
		expect(cost(batch)).toEqual({ cost: 5, toolCalls: 2 })
		expect(cost([]).cost).toBe(1)
		expect(cost([null, 7, 'x']).cost).toBe(1)
		expect(cost(null).cost).toBe(1)
	})
})

describe('token bucket', () => {
	it('lets a caller spend one minute of tokens, then refuses with a retry-after', () => {
		const { limiter } = makeLimiter({ agentPerMin: 60 })
		for (let i = 0; i < 60; i++) expect(limiter.check(agent()).outcome).toBe('allowed')
		const over = limiter.check(agent())
		expect(over.outcome).toBe('rejected')
		// 60 per minute is 1 per second, so one token is 1 second away.
		expect(over.retryAfterSeconds).toBe(1)
	})

	it('refills continuously', () => {
		const { limiter, advance } = makeLimiter({ agentPerMin: 60 })
		for (let i = 0; i < 60; i++) limiter.check(agent())
		expect(limiter.check(agent()).outcome).toBe('rejected')
		advance(1_000)
		expect(limiter.check(agent()).outcome).toBe('allowed')
		expect(limiter.check(agent()).outcome).toBe('rejected')
		// Idle for a long time: back to capacity, not above it.
		advance(10 * 60_000)
		let allowed = 0
		for (let i = 0; i < 100; i++) if (limiter.check(agent()).outcome === 'allowed') allowed++
		expect(allowed).toBe(60)
	})

	it('charges the cost of a write and does not consume on a rejection', () => {
		const { limiter, advance } = makeLimiter({ agentPerMin: 60 })
		for (let i = 0; i < 19; i++) expect(limiter.check(agent(3)).outcome).toBe('allowed') // 57
		// 3 tokens left: one more write fits.
		expect(limiter.check(agent(3)).outcome).toBe('allowed')
		const rejected = limiter.check(agent(3))
		expect(rejected.outcome).toBe('rejected')
		// Empty bucket, 3 tokens needed at 1 a second.
		expect(rejected.retryAfterSeconds).toBe(3)
		// The rejection took nothing: one second later there are 1 token, not -2.
		advance(3_000)
		expect(limiter.check(agent(3)).outcome).toBe('allowed')
	})

	it('computes retry-after from the shortfall and clamps it to 1..3600', () => {
		const slow = makeLimiter({ humanPerMin: 1 })
		const human = { ...agent(1), callerClass: 'human' as const }
		expect(slow.limiter.check(human).outcome).toBe('allowed')
		// 1 per minute: the next token is 60 seconds away.
		expect(slow.limiter.check(human).retryAfterSeconds).toBe(60)

		// Sub-second shortfall still tells the client to wait a whole second.
		const fast = makeLimiter({ agentPerMin: 100_000 })
		fast.limiter.check(agent(100_000))
		expect(fast.limiter.check(agent(1)).retryAfterSeconds).toBe(1)
	})

	it('prices a request dearer than the whole bucket at the bucket', () => {
		const { limiter } = makeLimiter({ humanPerMin: 10 })
		const human = (cost: number) => ({ ...agent(cost), callerClass: 'human' as const })
		// A 500-message batch against a bucket of 10 empties it instead of being
		// refused forever.
		const first = limiter.check(human(500))
		expect(first.outcome).toBe('allowed')
		const second = limiter.check(human(500))
		expect(second.outcome).toBe('rejected')
		expect(second.retryAfterSeconds).toBe(60)
	})

	it('log-only never rejects, counts would_reject, and uses the same accounting as enforce', () => {
		const { limiter } = makeLimiter({ mode: 'log-only', agentPerMin: 5 })
		const outcomes = Array.from({ length: 8 }, () => limiter.check(agent()).outcome)
		expect(outcomes).toEqual([
			'allowed',
			'allowed',
			'allowed',
			'allowed',
			'allowed',
			'would_reject',
			'would_reject',
			'would_reject',
		])
		const summary = limiter.flushSummary()
		expect(summary).toMatchObject({ agent_allowed: 5, agent_would_reject: 3, agent_rejected: 0 })
	})

	it('off does no accounting at all', () => {
		const { limiter, log } = makeLimiter({ mode: 'off', agentPerMin: 1 })
		for (let i = 0; i < 5; i++) expect(limiter.check(agent()).outcome).toBe('allowed')
		limiter.recordLookupError({ toolCalls: 1 })
		expect(limiter.sizes()).toEqual({ authed: 0, unknown: 0 })
		expect(limiter.flushSummary()).toBeNull()
		expect(log.warn).not.toHaveBeenCalled()
		const emit = vi.fn()
		limiter.startSummary(emit)
		expect(limiter.summaryRunning()).toBe(false)
	})
})

describe('classes and storage', () => {
	it('keeps agent, human and unknown buckets apart', () => {
		const { limiter } = makeLimiter({ agentPerMin: 2, unknownPerMin: 2 })
		expect(limiter.check(agent(2)).outcome).toBe('allowed')
		expect(limiter.check(agent()).outcome).toBe('rejected')
		// An empty agent bucket does not touch a stranger, nor another agent.
		expect(limiter.check(stranger('198.51.100.1', 2)).outcome).toBe('allowed')
		expect(limiter.check(agent(1, ACTOR_B)).outcome).toBe('allowed')
	})

	it('uses the limit of the caller class', () => {
		const { limiter } = makeLimiter()
		expect(limiter.check(agent()).limitPerMinute).toBe(600)
		expect(limiter.check({ ...agent(), callerClass: 'human' }).limitPerMinute).toBe(120)
		expect(limiter.check(stranger()).limitPerMinute).toBe(300)
	})

	it('shares one bucket among callers with the same key', () => {
		const { limiter } = makeLimiter({ unknownPerMin: 3 })
		expect(limiter.check(stranger('203.0.113.7', 3)).outcome).toBe('allowed')
		expect(limiter.check(stranger('203.0.113.7')).outcome).toBe('rejected')
		expect(limiter.check(stranger('203.0.113.8')).outcome).toBe('allowed')
	})

	it('bounds the unknown map and an unauthenticated flood never evicts an agent', () => {
		const { limiter } = makeLimiter({ agentPerMin: 5 })
		limiter.check(agent(5)) // drain agent A
		for (let i = 0; i < 10_500; i++) limiter.check(stranger(`ip-${i}`))
		const sizes = limiter.sizes()
		expect(sizes.unknown).toBeLessThanOrEqual(10_000)
		// Agent A's empty bucket survived the flood, so A is still limited.
		expect(sizes.authed).toBe(1)
		expect(limiter.check(agent()).outcome).toBe('rejected')
	})

	it('bounds the authenticated map oldest-first and keeps busy callers', () => {
		const { limiter } = makeLimiter({ agentPerMin: 5 })
		limiter.check(agent(5, 'busy')) // drained, inserted first
		for (let i = 0; i < 5_000; i++) {
			limiter.check(agent(1, `a-${i}`))
			// Touching the busy caller keeps it newest, so it is not the victim.
			if (i % 100 === 0) limiter.check(agent(0, 'busy'))
		}
		expect(limiter.sizes().authed).toBeLessThanOrEqual(5_000)
		expect(limiter.check(agent(1, 'busy')).outcome).toBe('rejected')
	})

	it('sweeps buckets idle past the ttl', () => {
		const { limiter, advance } = makeLimiter()
		limiter.check(stranger('a'))
		limiter.check(agent())
		expect(limiter.sizes()).toEqual({ authed: 1, unknown: 1 })
		advance(3 * 60_000)
		limiter.flushSummary()
		expect(limiter.sizes()).toEqual({ authed: 0, unknown: 0 })
	})
})

describe('exempt actors', () => {
	it('skips the limit and is still counted', () => {
		const { limiter } = makeLimiter({ agentPerMin: 1, exemptActorIds: new Set([ACTOR_A]) })
		for (let i = 0; i < 5; i++) expect(limiter.check(agent()).outcome).toBe('exempt')
		expect(limiter.check(agent(1, ACTOR_B)).outcome).toBe('allowed')
		expect(limiter.check(agent(1, ACTOR_B)).outcome).toBe('rejected')
		expect(limiter.flushSummary()).toMatchObject({ agent_exempt: 5 })
	})

	it('matches ids case-insensitively', () => {
		const { limiter } = makeLimiter({ exemptActorIds: new Set([ACTOR_A]) })
		const upper = { ...agent(), actorId: ACTOR_A.toUpperCase(), key: ACTOR_A.toUpperCase() }
		expect(limiter.check(upper).outcome).toBe('exempt')
	})
})

describe('summary', () => {
	it('is null without traffic and resets after each flush', () => {
		const { limiter } = makeLimiter({ mode: 'log-only' })
		expect(limiter.flushSummary()).toBeNull()
		limiter.check({ ...agent(), toolCalls: 2 })
		const first = limiter.flushSummary()
		expect(first).toMatchObject({ mode: 'log-only', agent_allowed: 1, tool_calls: 2 })
		expect(limiter.flushSummary()).toBeNull()
	})

	it('reports the window length from the injected clock', () => {
		const { limiter, advance } = makeLimiter()
		advance(0)
		limiter.check(agent())
		advance(60_000)
		expect(limiter.flushSummary()).toMatchObject({ window_seconds: 60 })
	})

	it('lists the top 5 actors by would_reject plus rejected, with no ips', () => {
		const { limiter } = makeLimiter({ mode: 'log-only', agentPerMin: 1 })
		const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
		ids.forEach((id, i) => {
			limiter.check(agent(1, id))
			// actor i is over the limit i times
			for (let n = 0; n < i; n++) limiter.check(agent(1, id))
		})
		limiter.check(stranger('203.0.113.99'))
		const summary = limiter.flushSummary()
		expect(summary?.top_actor_ids).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]])
		expect(summary?.top_actor_would_reject).toEqual([6, 5, 4, 3, 2])
		expect(summary?.top_actor_rejected).toEqual([0, 0, 0, 0, 0])
		expect(JSON.stringify(summary)).not.toContain('203.0.113.99')
	})

	it('counts unknown_with_key only for keys that did not resolve', () => {
		const { limiter } = makeLimiter({ mode: 'log-only' })
		limiter.check(stranger('1.1.1.1', 1, false)) // no key at all
		limiter.check(stranger('1.1.1.2', 1, true)) // a key that did not resolve
		limiter.check(stranger('1.1.1.3', 1, true))
		limiter.check(agent()) // a key that resolved
		limiter.recordLookupError({ toolCalls: 0 }) // lookup error, never judged
		const summary = limiter.flushSummary()
		expect(summary).toMatchObject({
			unknown_with_key: 2,
			unknown_allowed: 3,
			unknown_lookup_error: 1,
			agent_allowed: 1,
		})
	})

	it('warns once per actor per minute in enforce, not in log-only', () => {
		const enforce = makeLimiter({ agentPerMin: 1 })
		enforce.limiter.check(agent())
		for (let i = 0; i < 5; i++) enforce.limiter.check(agent(3))
		expect(enforce.log.warn).toHaveBeenCalledTimes(1)
		expect(enforce.log.warn).toHaveBeenCalledWith(
			'mcp_rate_limit_rejected',
			expect.objectContaining({ actor_id: ACTOR_A, class: 'agent', cost: 3, limit_per_minute: 1 }),
		)
		enforce.advance(61_000)
		enforce.limiter.check(agent())
		enforce.limiter.check(agent(3))
		expect(enforce.log.warn).toHaveBeenCalledTimes(2)

		const logOnly = makeLimiter({ mode: 'log-only', agentPerMin: 1 })
		logOnly.limiter.check(agent())
		logOnly.limiter.check(agent())
		expect(logOnly.log.warn).not.toHaveBeenCalled()
	})

	it('runs an unref-ed interval that emits only when there was traffic, and stops', () => {
		vi.useFakeTimers()
		try {
			const log = { info: vi.fn(), warn: vi.fn() }
			const limiter = createMcpRateLimiter({
				config: { ...DEFAULT_RATE_LIMIT_CONFIG, mode: 'log-only' },
				readToolNames: READ,
				now: () => Date.now(),
				log,
			})
			const emit = vi.fn()
			limiter.startSummary(emit)
			limiter.startSummary(emit) // second start is a no-op
			vi.advanceTimersByTime(60_000)
			expect(emit).not.toHaveBeenCalled()
			limiter.check(agent())
			vi.advanceTimersByTime(60_000)
			expect(emit).toHaveBeenCalledTimes(1)
			expect(limiter.summaryRunning()).toBe(true)
			limiter.stop()
			limiter.stop()
			expect(limiter.summaryRunning()).toBe(false)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('rejection body', () => {
	const args = { retryAfterSeconds: 12, limitPerMinute: 600, callerClass: 'agent' as const }

	it('echoes the request id in the documented shape', () => {
		expect(buildRejectionBody({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, args)).toEqual({
			jsonrpc: '2.0',
			id: 7,
			error: {
				code: -32029,
				message: 'Rate limit exceeded for this API key. Retry after 12 seconds.',
				data: { retry_after_seconds: 12, limit_per_minute: 600, class: 'agent' },
			},
		})
	})

	it('uses a null id when the request has none', () => {
		expect(buildRejectionBody({ jsonrpc: '2.0', method: 'notifications/x' }, args)).toMatchObject({
			id: null,
		})
		expect(buildRejectionBody('junk', args)).toMatchObject({ id: null })
	})

	it('answers a batch with one error per request that has an id', () => {
		const body = buildRejectionBody(
			[
				{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				{ jsonrpc: '2.0', id: 'b', method: 'ping' },
			],
			args,
		) as Array<{ id: unknown }>
		expect(body.map((b) => b.id)).toEqual([1, 'b'])
	})

	it('falls back to one null-id error for a batch with no ids', () => {
		const body = buildRejectionBody([{ method: 'notifications/x' }], args)
		expect(Array.isArray(body)).toBe(false)
		expect(body).toMatchObject({ id: null })
	})
})

describe('config parsing', () => {
	const warnings = () => {
		const warn = vi.fn()
		return { warn }
	}

	it('defaults to log-only with the documented numbers', () => {
		const { warn } = warnings()
		const config = resolveRateLimitConfig({ MASKIN_MCP_RATE_LIMIT_MODE: 'log-only' }, warn)
		expect(config).toMatchObject({
			mode: 'log-only',
			agentPerMin: 600,
			humanPerMin: 120,
			unknownPerMin: 300,
			writeCost: 3,
		})
		expect(config.exemptActorIds.size).toBe(0)
		expect(warn).not.toHaveBeenCalled()
	})

	it.each(['log-only', 'enforce', 'off', ' ENFORCE ', 'Off'])('accepts mode %j', (raw) => {
		const warn = vi.fn()
		expect(parseMode(raw, warn)).toBe(raw.trim().toLowerCase())
		expect(warn).not.toHaveBeenCalled()
	})

	it.each([undefined, '', '  ', 'enforced', 'true', '1', 'on'])(
		'treats mode %j as log-only with one warning',
		(raw) => {
			const warn = vi.fn()
			expect(parseMode(raw, warn)).toBe('log-only')
			expect(warn).toHaveBeenCalledTimes(1)
		},
	)

	it.each(['abc', 'NaN', 'Infinity', '-5', '0', '1.5', '100001', '1e9', '12abc'])(
		'falls back to the default for per-minute value %j with one warning',
		(raw) => {
			const warn = vi.fn()
			const config = resolveRateLimitConfig(
				{ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: raw },
				warn,
			)
			expect(config.agentPerMin).toBe(600)
			expect(warn).toHaveBeenCalledTimes(1)
		},
	)

	it('accepts the bounds and ignores whitespace', () => {
		const warn = vi.fn()
		const config = resolveRateLimitConfig(
			{
				MASKIN_MCP_RATE_LIMIT_MODE: 'enforce',
				MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1',
				MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN: '100000',
				MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN: ' 42 ',
				MASKIN_MCP_RATE_LIMIT_WRITE_COST: '50',
			},
			warn,
		)
		expect(config).toMatchObject({
			agentPerMin: 1,
			humanPerMin: 100_000,
			unknownPerMin: 42,
			writeCost: 50,
		})
		expect(warn).not.toHaveBeenCalled()
	})

	it('bounds the write cost to 1..50', () => {
		const warn = vi.fn()
		const cost = (raw: string) =>
			resolveRateLimitConfig(
				{ MASKIN_MCP_RATE_LIMIT_MODE: 'off', MASKIN_MCP_RATE_LIMIT_WRITE_COST: raw },
				warn,
			).writeCost
		expect(cost('0')).toBe(3)
		expect(cost('51')).toBe(3)
		expect(cost('-1')).toBe(3)
		expect(cost('2.5')).toBe(3)
		expect(cost('1')).toBe(1)
		expect(warn).toHaveBeenCalledTimes(4)
	})

	it('stays silent for an empty numeric variable', () => {
		const warn = vi.fn()
		const config = resolveRateLimitConfig(
			{ MASKIN_MCP_RATE_LIMIT_MODE: 'off', MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN: '' },
			warn,
		)
		expect(config.humanPerMin).toBe(120)
		expect(warn).not.toHaveBeenCalled()
	})

	it('parses exempt ids, lowercases them and drops bad entries with a warning', () => {
		const warn = vi.fn()
		const ids = parseExemptActorIds(` ${ACTOR_A.toUpperCase()}, not-a-uuid ,,${ACTOR_B}`, warn)
		expect([...ids]).toEqual([ACTOR_A, ACTOR_B])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(parseExemptActorIds(undefined, warn).size).toBe(0)
		expect(parseExemptActorIds('', warn).size).toBe(0)
	})

	it('describes the config without ids', () => {
		const config = {
			...DEFAULT_RATE_LIMIT_CONFIG,
			exemptActorIds: new Set([ACTOR_A]),
		}
		const described = describeConfig(config)
		expect(described).toMatchObject({ mode: 'log-only', exempt_actor_count: 1 })
		expect(JSON.stringify(described)).not.toContain(ACTOR_A)
	})
})
