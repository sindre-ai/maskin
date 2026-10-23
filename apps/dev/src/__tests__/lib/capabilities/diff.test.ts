import { describe, expect, it } from 'vitest'
import {
	type CapabilitySnapshot,
	type DiffInput,
	type ProbeOutcome,
	availableNotAttachedFinding,
	dedupeKeyFor,
	diffCapabilities,
} from '../../../lib/capabilities/diff'
import { hashServerSpec, hashToolSchema, sha256 } from '../../../lib/capabilities/schema-hash'
import type { ProviderConfig } from '../../../lib/integrations/types'

const WS = '11111111-1111-4111-8111-111111111111'
const SOURCE = 'integration:slack:22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-10-13T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function snapshot(
	tools: Record<string, string>,
	overrides: Partial<CapabilitySnapshot> = {},
): CapabilitySnapshot {
	return {
		v: 1,
		source: SOURCE,
		scanned_at: '2026-10-12T12:00:00.000Z',
		tools,
		spec_hash: null,
		removed: {},
		...overrides,
	}
}

function ok(tools: Record<string, string>, specHash: string | null = null): ProbeOutcome {
	return { ok: true, tools, specHash }
}

function run(overrides: Partial<DiffInput>) {
	return diffCapabilities({
		workspaceId: WS,
		source: SOURCE,
		prev: null,
		probe: ok({}),
		holders: [AGENT],
		priorFailures: 0,
		now: NOW,
		...overrides,
	})
}

describe('diffCapabilities', () => {
	it('baseline: no previous snapshot writes a snapshot and emits nothing', () => {
		const result = run({ probe: ok({ a: 'h1', b: 'h2' }) })
		expect(result.mode).toBe('baseline')
		expect(result.findings).toEqual([])
		expect(result.next?.tools).toEqual({ a: 'h1', b: 'h2' })
		expect(result.counts.tools_total).toBe(2)
		expect(result.counts.tools_added).toBe(0)
	})

	it('no change: writes no snapshot and no finding', () => {
		const result = run({ prev: snapshot({ a: 'h1' }), probe: ok({ a: 'h1' }) })
		expect(result.mode).toBe('diff')
		expect(result.next).toBeNull()
		expect(result.findings).toEqual([])
	})

	it('added tool: one flagged tool_added with the dedupe key', () => {
		const result = run({ prev: snapshot({ a: 'h1' }), probe: ok({ a: 'h1', b: 'h2' }) })
		expect(result.findings).toEqual([
			{
				kind: 'tool_added',
				source: SOURCE,
				tools: ['b'],
				flagged: true,
				dedupeKey: dedupeKeyFor(WS, SOURCE, 'tool_added', 'b', 'h2'),
			},
		])
		expect(result.next?.tools).toEqual({ a: 'h1', b: 'h2' })
		expect(result.counts.tools_added).toBe(1)
	})

	it('dedupe key ignores holders and changes with the schema hash', () => {
		const one = run({ prev: snapshot({}), probe: ok({ b: 'h2' }), holders: [AGENT] })
		const two = run({ prev: snapshot({}), probe: ok({ b: 'h2' }), holders: [] })
		const three = run({ prev: snapshot({}), probe: ok({ b: 'h3' }), holders: [AGENT] })
		expect(one.findings[0].dedupeKey).toBe(two.findings[0].dedupeKey)
		expect(one.findings[0].dedupeKey).not.toBe(three.findings[0].dedupeKey)
	})

	it('removed tool: recorded in removed with a timestamp, never flagged', () => {
		const result = run({ prev: snapshot({ a: 'h1', b: 'h2' }), probe: ok({ a: 'h1' }) })
		expect(result.findings).toEqual([
			{ kind: 'tool_removed', source: SOURCE, tools: ['b'], flagged: false, dedupeKey: null },
		])
		expect(result.next?.tools).toEqual({ a: 'h1' })
		expect(result.next?.removed).toEqual({ b: NOW.toISOString() })
		expect(result.counts.tools_removed).toBe(1)
	})

	it('schema change: recorded, never flagged', () => {
		const result = run({ prev: snapshot({ a: 'h1' }), probe: ok({ a: 'h9' }) })
		expect(result.findings).toEqual([
			{ kind: 'schema_changed', source: SOURCE, tools: ['a'], flagged: false, dedupeKey: null },
		])
		expect(result.next?.tools).toEqual({ a: 'h9' })
		expect(result.counts.schema_changed).toBe(1)
	})

	it('a failed probe keeps the previous snapshot and is never a removal', () => {
		const prev = snapshot({ a: 'h1', b: 'h2' })
		const result = run({ prev, probe: { ok: false }, priorFailures: 0 })
		expect(result.mode).toBe('failed')
		expect(result.next).toBeNull()
		expect(result.findings).toEqual([])
		expect(result.consecutiveFailures).toBe(1)
		expect(result.counts.tools_removed).toBe(0)
		expect(result.counts.tools_total).toBe(2)
	})

	it('reports source_unreachable once, on the third failure in a row', () => {
		const prev = snapshot({ a: 'h1' })
		const second = run({ prev, probe: { ok: false }, priorFailures: 1 })
		const third = run({ prev, probe: { ok: false }, priorFailures: 2 })
		const fourth = run({ prev, probe: { ok: false }, priorFailures: 3 })
		expect(second.findings).toEqual([])
		expect(third.findings).toEqual([
			{ kind: 'source_unreachable', source: SOURCE, tools: [], flagged: false, dedupeKey: null },
		])
		expect(fourth.findings).toEqual([])
	})

	it('a success resets the failure count', () => {
		const result = run({ prev: snapshot({ a: 'h1' }), probe: ok({ a: 'h1' }), priorFailures: 2 })
		expect(result.consecutiveFailures).toBe(0)
	})

	describe('tombstones', () => {
		it('a tool that flaps back inside 30 days stays silent', () => {
			const removedAt = new Date(NOW.getTime() - 10 * DAY).toISOString()
			const result = run({
				prev: snapshot({ a: 'h1' }, { removed: { b: removedAt } }),
				probe: ok({ a: 'h1', b: 'h2' }),
			})
			expect(result.findings).toEqual([])
			expect(result.next?.tools).toEqual({ a: 'h1', b: 'h2' })
			expect(result.next?.removed).toEqual({})
			expect(result.counts.tools_added).toBe(0)
		})

		it('a tool that comes back after 31 days is flagged again', () => {
			const removedAt = new Date(NOW.getTime() - 31 * DAY).toISOString()
			const result = run({
				prev: snapshot({ a: 'h1' }, { removed: { b: removedAt } }),
				probe: ok({ a: 'h1', b: 'h2' }),
			})
			expect(result.findings.map((f) => [f.kind, f.tools, f.flagged])).toEqual([
				['tool_added', ['b'], true],
			])
		})

		it('drops tombstones older than 30 days from the next snapshot', () => {
			const old = new Date(NOW.getTime() - 40 * DAY).toISOString()
			const recent = new Date(NOW.getTime() - 5 * DAY).toISOString()
			const result = run({
				prev: snapshot({ a: 'h1' }, { removed: { x: old, y: recent } }),
				probe: ok({ a: 'h1', c: 'h3' }),
			})
			expect(result.next?.removed).toEqual({ y: recent })
		})
	})

	it('a tool added to a source with no holder is stored and not flagged', () => {
		const result = run({
			prev: snapshot({ a: 'h1' }),
			probe: ok({ a: 'h1', b: 'h2' }),
			holders: [],
		})
		expect(result.next?.tools).toEqual({ a: 'h1', b: 'h2' })
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0]).toMatchObject({ kind: 'tool_added', flagged: false })
		expect(result.counts.tools_added).toBe(1)
	})

	it('a stdio spec hash change is recorded, never flagged', () => {
		const before = hashServerSpec({ command: 'github-mcp-server', args: ['stdio'] })
		const after = hashServerSpec({
			command: 'github-mcp-server',
			args: ['stdio', '--toolsets', 'x'],
		})
		const result = run({
			prev: snapshot({}, { spec_hash: before }),
			probe: ok({}, after),
		})
		expect(result.findings).toEqual([
			{ kind: 'server_spec_changed', source: SOURCE, tools: [], flagged: false, dedupeKey: null },
		])
		expect(result.next?.spec_hash).toBe(after)
	})

	it('handles a 500-tool list: 3 added, 2 removed, 1 changed among 500', () => {
		const prevTools: Record<string, string> = {}
		for (let i = 0; i < 500; i++) prevTools[`tool_${String(i).padStart(3, '0')}`] = `h${i}`
		const { tool_000: _removedA, tool_001: _removedB, ...currTools } = prevTools
		currTools.tool_002 = 'changed'
		currTools.new_a = 'n1'
		currTools.new_b = 'n2'
		currTools.new_c = 'n3'
		const result = run({ prev: snapshot(prevTools), probe: ok(currTools) })
		expect(result.counts).toEqual({
			tools_total: 501,
			tools_added: 3,
			tools_removed: 2,
			schema_changed: 1,
		})
		const added = result.findings.filter((f) => f.kind === 'tool_added').map((f) => f.tools[0])
		expect(added).toEqual(['new_a', 'new_b', 'new_c'])
	})
})

describe('hashToolSchema', () => {
	const base = {
		type: 'object',
		properties: { channel: { type: 'string', description: 'Where to post' } },
		required: ['channel'],
	}

	it('a description-only change is no change', () => {
		const edited = {
			type: 'object',
			properties: { channel: { type: 'string', description: 'Completely reworded' } },
			required: ['channel'],
			description: 'Now with a top-level description',
		}
		expect(hashToolSchema(edited)).toBe(hashToolSchema(base))
	})

	it('key order is irrelevant', () => {
		const shuffled = {
			required: ['channel'],
			properties: { channel: { description: 'Where to post', type: 'string' } },
			type: 'object',
		}
		expect(hashToolSchema(shuffled)).toBe(hashToolSchema(base))
	})

	it('an added parameter is a change', () => {
		const withParam = {
			...base,
			properties: { ...base.properties, thread_ts: { type: 'string' } },
		}
		expect(hashToolSchema(withParam)).not.toBe(hashToolSchema(base))
	})

	it('a parameter that is itself named description is not stripped', () => {
		const withoutParam = { type: 'object', properties: {} }
		const withParam = { type: 'object', properties: { description: { type: 'string' } } }
		expect(hashToolSchema(withParam)).not.toBe(hashToolSchema(withoutParam))
	})

	it('is a sha256 hex digest of the canonical schema', () => {
		expect(hashToolSchema({ type: 'object' })).toBe(sha256('{"type":"object"}'))
	})
})

describe('diffCapabilities: needs_reconnect', () => {
	const config: ProviderConfig = {
		name: 'slack',
		displayName: 'Slack',
		auth: {
			type: 'oauth2',
			config: {
				authorizationUrl: 'https://example.com/auth',
				tokenUrl: 'https://example.com/token',
				scopes: ['chat:write', 'search:read'],
				clientIdEnv: 'SLACK_CLIENT_ID',
				clientSecretEnv: 'SLACK_CLIENT_SECRET',
			},
		},
	}
	const added = { prev: snapshot({ a: 'h1' }), probe: ok({ a: 'h1', b: 'h2' }) }

	it('a new tool on a token missing a required scope is needs_reconnect, with scope names only', () => {
		const result = run({
			...added,
			connection: { config, credentials: { scope: 'chat:write' } },
		})
		expect(result.findings).toEqual([
			{
				kind: 'needs_reconnect',
				source: SOURCE,
				tools: ['b'],
				flagged: true,
				dedupeKey: dedupeKeyFor(WS, SOURCE, 'needs_reconnect', 'b', 'h2'),
				missingScopes: ['search:read'],
			},
		])
		expect(result.counts.tools_added).toBe(1)
	})

	it('a token that has every scope keeps the finding as tool_added', () => {
		const result = run({
			...added,
			connection: { config, credentials: { scope: 'chat:write search:read' } },
		})
		expect(result.findings.map((f) => f.kind)).toEqual(['tool_added'])
		expect(result.findings[0]).not.toHaveProperty('missingScopes')
	})

	it('needs_reconnect on a source nobody holds is not flagged', () => {
		const result = run({
			...added,
			holders: [],
			connection: { config, credentials: { scope: 'chat:write' } },
		})
		expect(result.findings).toEqual([
			{
				kind: 'tool_added',
				source: SOURCE,
				tools: ['b'],
				flagged: false,
				dedupeKey: dedupeKeyFor(WS, SOURCE, 'tool_added', 'b', 'h2'),
			},
		])
	})

	it('a token with no stored scope string is unknown, not drift', () => {
		const result = run({ ...added, connection: { config, credentials: {} } })
		expect(result.findings.map((f) => f.kind)).toEqual(['tool_added'])
	})

	it('the dedupe key separates the two kinds for the same tool', () => {
		expect(dedupeKeyFor(WS, SOURCE, 'needs_reconnect', 'b', 'h2')).not.toBe(
			dedupeKeyFor(WS, SOURCE, 'tool_added', 'b', 'h2'),
		)
	})
})

describe('availableNotAttachedFinding', () => {
	it('is flagged, names no tool and no agent, and keys on workspace, source and kind', () => {
		const finding = availableNotAttachedFinding(WS, SOURCE)
		expect(finding).toEqual({
			kind: 'available_not_attached',
			source: SOURCE,
			tools: [],
			flagged: true,
			dedupeKey: dedupeKeyFor(WS, SOURCE, 'available_not_attached', '', ''),
		})
		expect(availableNotAttachedFinding(WS, SOURCE).dedupeKey).toBe(finding.dedupeKey)
		expect(availableNotAttachedFinding(WS, `${SOURCE}x`).dedupeKey).not.toBe(finding.dedupeKey)
	})
})
