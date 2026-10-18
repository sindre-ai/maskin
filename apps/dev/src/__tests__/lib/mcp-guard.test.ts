import { describe, expect, it } from 'vitest'
import {
	GUARD_BIN,
	GUARD_KEY_GRACE_MS,
	buildGuardPolicy,
	guardKeyExpired,
	guardKeyMatches,
	guardServer,
	hashGuardKey,
	mintGuardKey,
	parseGuardKey,
} from '../../lib/integrations/mcp-guard'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const opts = { reportUrl: 'https://api.example/report', sessionKey: 'key' }

describe('buildGuardPolicy', () => {
	it('denies every tool for an agent with no entry', () => {
		expect(buildGuardPolicy({ [OTHER_AGENT]: { get_x: 'allow' } }, AGENT)).toEqual({
			allow: [],
			deny: [],
		})
		expect(buildGuardPolicy(null, AGENT)).toEqual({ allow: [], deny: [] })
	})

	it('splits allow and deny, including the object form', () => {
		const policy = buildGuardPolicy(
			{
				[AGENT]: {
					get_x: 'allow',
					put_x: 'deny',
					list_x: { effect: 'allow', expires_at: null, grant_id: 'g1' },
					drop_x: { effect: 'deny', expires_at: null, grant_id: 'g2' },
				},
			},
			AGENT,
		)
		expect(policy.allow.sort()).toEqual(['get_x', 'list_x'])
		expect(policy.deny.sort()).toEqual(['drop_x', 'put_x'])
	})

	it('does not read an expiry', () => {
		const past = { effect: 'allow' as const, expires_at: '2000-01-01T00:00:00.000Z', grant_id: 'g' }
		expect(buildGuardPolicy({ [AGENT]: { get_x: past } }, AGENT).allow).toEqual(['get_x'])
	})
})

describe('guardServer', () => {
	const policy = { allow: ['get_x'], deny: ['put_x'] }

	it('starts the wrapper first and the real server as its child', () => {
		const out = guardServer(
			{ type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://v.example/mcp'] },
			policy,
			opts,
		)
		expect(out?.command).toBe(GUARD_BIN)
		expect(out?.args).toEqual(['--', 'npx', 'mcp-remote', 'https://v.example/mcp'])
	})

	it('keeps guard settings and the session key in env, never in args', () => {
		const out = guardServer({ command: 'npx', args: [], env: { TOKEN: 't' } }, policy, opts)
		expect(out?.env).toEqual({
			TOKEN: 't',
			MASKIN_GUARD_ALLOW: '["get_x"]',
			MASKIN_GUARD_DENY: '["put_x"]',
			MASKIN_GUARD_REPORT_URL: opts.reportUrl,
			MASKIN_GUARD_SESSION_KEY: 'key',
		})
		expect(JSON.stringify(out?.args)).not.toContain('key')
	})

	it('refuses a server the wrapper cannot front', () => {
		expect(guardServer({ type: 'http', url: 'https://v.example' }, policy, opts)).toBeNull()
		expect(guardServer(null, policy, opts)).toBeNull()
	})
})

describe('session keys', () => {
	const S = '33333333-3333-4333-8333-333333333333'
	const E = '44444444-4444-4444-8444-444444444444'

	it('round-trips the ids and matches only its own hash', () => {
		const a = mintGuardKey(S, E)
		const b = mintGuardKey(S, E)
		expect(parseGuardKey(a.key)).toEqual({ sessionId: S, extensionId: E })
		expect(a.key).not.toBe(b.key)
		expect(guardKeyMatches(a.key, a.hash)).toBe(true)
		expect(guardKeyMatches(a.key, b.hash)).toBe(false)
		expect(guardKeyMatches(a.key, undefined)).toBe(false)
		expect(a.hash).toBe(hashGuardKey(a.key))
	})

	it('rejects malformed keys', () => {
		expect(parseGuardKey('nope')).toBeNull()
		expect(parseGuardKey(`mgk2.${S}.${E}.x`)).toBeNull()
		expect(parseGuardKey(`mgk1.${S}.${E}.`)).toBeNull()
		expect(parseGuardKey('mgk1.a.b.c')).toBeNull()
	})
})

describe('guardKeyExpired', () => {
	const now = Date.parse('2026-10-18T12:00:00Z')
	const ago = (ms: number) => new Date(now - ms)
	const terminal = ['completed', 'failed']

	it('never expires while the session is live', () => {
		const live = { status: 'running', completedAt: null, updatedAt: ago(1e9) }
		expect(guardKeyExpired(live, terminal, now)).toBe(false)
	})

	it('holds for the grace window after the session ends, then expires', () => {
		const ended = (msAgo: number) => ({
			status: 'completed',
			completedAt: ago(msAgo),
			updatedAt: null,
		})
		const inside = ended(GUARD_KEY_GRACE_MS - 1000)
		const outside = ended(GUARD_KEY_GRACE_MS + 1000)
		expect(guardKeyExpired(inside, terminal, now)).toBe(false)
		expect(guardKeyExpired(outside, terminal, now)).toBe(true)
	})

	it('fails closed when an ended session has no timestamp', () => {
		const undated = { status: 'failed', completedAt: null, updatedAt: null }
		expect(guardKeyExpired(undated, terminal, now)).toBe(true)
	})
})
