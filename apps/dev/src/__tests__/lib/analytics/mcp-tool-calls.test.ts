import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

import { listCallObjectType } from '@maskin/shared'
import { classifyMcpClient } from '../../../lib/analytics/mcp-client'
import {
	MCP_HANDSHAKE_ANONYMOUS_DISTINCT_ID,
	MCP_HANDSHAKE_EVENT,
	argKeys,
	captureMcpHandshake,
	captureMcpToolCall,
	normalizeActorType,
} from '../../../lib/analytics/mcp-tool-calls'
import { capturePosthogEvent } from '../../../lib/analytics/posthog'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'

function baseTrace() {
	return {
		sessionId: 'session-1',
		sessionSource: 'maskin-session' as const,
		seq: 3,
		toolName: 'list_objects',
		argKeys: [] as string[],
		ok: true,
		errorClass: null,
		durationMs: 42,
		responseBytes: 1024,
		transport: 'http' as const,
		agentActorId: ACTOR_ID,
		authMethod: 'api_key' as 'api_key' | null,
		client: 'claude_code' as ReturnType<typeof classifyMcpClient>,
		actorType: 'agent' as 'human' | 'agent' | null,
	}
}

describe('argKeys', () => {
	it('returns sorted key names', () => {
		expect(argKeys({ type: 'bet', workspace_id: 'w', limit: 5 })).toEqual([
			'limit',
			'type',
			'workspace_id',
		])
	})

	it('returns an empty list for non-object arguments', () => {
		expect(argKeys(undefined)).toEqual([])
		expect(argKeys(null)).toEqual([])
		expect(argKeys('a secret string')).toEqual([])
		expect(argKeys(['a secret element'])).toEqual([])
	})

	// A key name can itself be free text. Recording key names is only safe
	// because they are identifier-shaped, so anything that isn't gets dropped
	// rather than carried into analytics as a "key".
	it('drops keys that are not identifier-shaped', () => {
		expect(argKeys({ 'Acquire the Nakatomi account': 1, workspace_id: 'w' })).toEqual([
			'workspace_id',
		])
		expect(argKeys({ 'user@example.com': 1 })).toEqual([])
		expect(argKeys({ 'owner:login': 1 })).toEqual([])
	})

	it('drops over-long keys and caps the number of keys', () => {
		expect(argKeys({ ['a'.repeat(65)]: 1 })).toEqual([])
		expect(argKeys({ ['a'.repeat(64)]: 1 })).toEqual(['a'.repeat(64)])
		const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
		expect(argKeys(many)).toHaveLength(64)
	})
})

describe('normalizeActorType', () => {
	it('passes through human and agent and nulls everything else', () => {
		expect(normalizeActorType('human')).toBe('human')
		expect(normalizeActorType('agent')).toBe('agent')
		expect(normalizeActorType('system')).toBeNull()
		expect(normalizeActorType('')).toBeNull()
		expect(normalizeActorType(undefined)).toBeNull()
		expect(normalizeActorType(null)).toBeNull()
	})
})

describe('captureMcpToolCall', () => {
	beforeEach(() => vi.mocked(capturePosthogEvent).mockClear())
	afterEach(() => vi.restoreAllMocks())

	it('emits the ordering fields needed to reconstruct a session', async () => {
		await captureMcpToolCall(WORKSPACE_ID, baseTrace())
		const [event, distinctId, props] = vi.mocked(capturePosthogEvent).mock.calls[0]
		expect(event).toBe('mcp_tool_call')
		expect(distinctId).toBe(ACTOR_ID)
		expect(props).toMatchObject({
			session_id: 'session-1',
			session_source: 'maskin-session',
			seq: 3,
			tool_name: 'list_objects',
			ok: true,
			transport: 'http',
			workspace_id: WORKSPACE_ID,
		})
	})

	it('emits auth_method, client and actor_type', async () => {
		await captureMcpToolCall(WORKSPACE_ID, baseTrace())
		expect(vi.mocked(capturePosthogEvent).mock.calls[0][2]).toMatchObject({
			auth_method: 'api_key',
			client: 'claude_code',
			actor_type: 'agent',
		})
	})

	it('emits object_type for each list-family tool', async () => {
		const cases = [
			['list_objects', { type: 'task' }, 'task'],
			['search_objects', { type: 'bet' }, 'bet'],
			['list_triggers', {}, 'trigger'],
			['list_loops', {}, 'loop'],
			['list_workspace_skills', {}, 'skill'],
			['list_extensions', {}, 'extension'],
		] as const
		for (const [toolName, args, expected] of cases) {
			vi.mocked(capturePosthogEvent).mockClear()
			await captureMcpToolCall(WORKSPACE_ID, {
				...baseTrace(),
				toolName,
				argKeys: argKeys(args),
				objectType: listCallObjectType(toolName, args),
			})
			expect(vi.mocked(capturePosthogEvent).mock.calls[0][2]).toMatchObject({
				object_type: expected,
			})
		}
	})

	it('records a custom type as other and leaves no free text in the event', async () => {
		const freeText = 'Acquire the Nakatomi account'
		const args = { type: freeText }
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			argKeys: argKeys(args),
			objectType: listCallObjectType('list_objects', args),
		})
		const props = vi.mocked(capturePosthogEvent).mock.calls[0][2]
		expect(props.object_type).toBe('other')
		expect(JSON.stringify(props)).not.toContain(freeText)
	})

	it('omits object_type for a tool outside the list family', async () => {
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			toolName: 'create_objects',
			objectType: listCallObjectType('create_objects', { type: 'task' }),
		})
		expect(vi.mocked(capturePosthogEvent).mock.calls[0][2].object_type).toBeUndefined()
	})

	it('emits null auth_method and actor_type for an unresolved caller, never api_key', async () => {
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			agentActorId: null,
			authMethod: null,
			actorType: null,
			client: 'other',
		})
		const props = vi.mocked(capturePosthogEvent).mock.calls[0][2]
		expect(props).toHaveProperty('auth_method', null)
		expect(props).toHaveProperty('actor_type', null)
		expect(props).toHaveProperty('client', 'other')
	})

	it('falls back to the workspace as distinct id when the actor is unknown', async () => {
		await captureMcpToolCall(WORKSPACE_ID, { ...baseTrace(), agentActorId: null })
		expect(vi.mocked(capturePosthogEvent).mock.calls[0][1]).toBe(WORKSPACE_ID)
	})

	// The guardrail. This asserts the privacy contract of the whole feature:
	// argument VALUES must never reach analytics, only key names. If someone
	// later adds a field that carries a value through, this fails.
	it('never emits argument values, only key names', async () => {
		const secrets = ['Acquire the Nakatomi account', 'sk-live-supersecret', 'user@example.com']
		const args = {
			title: secrets[0],
			api_key: secrets[1],
			owner_email: secrets[2],
			nested: { inner_secret: secrets[0] },
		}
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			toolName: 'create_objects',
			argKeys: argKeys(args),
		})
		const props = vi.mocked(capturePosthogEvent).mock.calls[0][2]
		const serialized = JSON.stringify(props)
		for (const secret of secrets) {
			expect(serialized).not.toContain(secret)
		}
		// Key names DO come through — that's the signal we intend to keep.
		expect(props.arg_keys).toEqual(['api_key', 'nested', 'owner_email', 'title'])
		// ...and nested keys do not, since nesting is not traversed.
		expect(serialized).not.toContain('inner_secret')
	})

	// The new properties are labels from fixed sets. Whatever the caller sent,
	// no raw User-Agent, key, token or key prefix may appear in any property.
	it('never emits the raw User-Agent, key, token or key prefix', async () => {
		const rawUserAgent = 'claude-cli/2.0.14 (external, cli) build-7f3a9c linux-6.12'
		const apiKey = 'ank_0123456789abcdef0123456789abcdef'
		const oauthToken = 'mat_abcdef0123456789abcdef0123456789'
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			client: classifyMcpClient(rawUserAgent),
		})
		const props = vi.mocked(capturePosthogEvent).mock.calls[0][2]
		const serialized = JSON.stringify(props)
		expect(props.client).toBe('claude_code')
		for (const forbidden of [rawUserAgent, 'build-7f3a9c', 'linux-6.12', apiKey, oauthToken]) {
			expect(serialized).not.toContain(forbidden)
		}
		for (const prefix of ['ank_', 'mat_', 'mrt_', 'Bearer']) {
			expect(serialized).not.toContain(prefix)
		}
	})
})

describe('captureMcpToolCall era labels', () => {
	beforeEach(() => {
		vi.mocked(capturePosthogEvent).mockClear()
	})

	it('emits mcp_era and mcp_protocol_version when classified', async () => {
		await captureMcpToolCall(WORKSPACE_ID, {
			...baseTrace(),
			mcpEra: 'legacy',
			mcpProtocolVersion: '2025-06-18',
		})
		expect(vi.mocked(capturePosthogEvent).mock.calls[0][2]).toMatchObject({
			mcp_era: 'legacy',
			mcp_protocol_version: '2025-06-18',
		})
	})

	// Absent, not a guess: a classifier fault must not read as "legacy".
	it('leaves both properties out when the classifier faulted', async () => {
		await captureMcpToolCall(WORKSPACE_ID, baseTrace())
		const props = vi.mocked(capturePosthogEvent).mock.calls[0][2]
		expect(props.mcp_era).toBeUndefined()
		expect(props.mcp_protocol_version).toBeUndefined()
		expect(JSON.parse(JSON.stringify(props))).not.toHaveProperty('mcp_era')
	})
})

describe('captureMcpHandshake', () => {
	beforeEach(() => {
		vi.mocked(capturePosthogEvent).mockClear()
	})

	function handshake(overrides: Record<string, unknown> = {}) {
		return {
			handshakeMethod: 'initialize' as const,
			outcome: 'ok' as const,
			mcpEra: 'legacy' as const,
			mcpProtocolVersion: 'none' as const,
			client: 'claude_code' as ReturnType<typeof classifyMcpClient>,
			transport: 'http' as const,
			authMethod: 'api_key' as 'api_key' | null,
			agentActorId: ACTOR_ID as string | null,
			...overrides,
		}
	}

	it('emits one mcp_handshake with the full property set, keyed on the actor', async () => {
		await captureMcpHandshake(WORKSPACE_ID, handshake())
		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = vi.mocked(capturePosthogEvent).mock.calls[0]
		expect(event).toBe(MCP_HANDSHAKE_EVENT)
		expect(event).toBe('mcp_handshake')
		expect(distinctId).toBe(ACTOR_ID)
		expect(props).toEqual({
			handshake_method: 'initialize',
			outcome: 'ok',
			mcp_era: 'legacy',
			mcp_protocol_version: 'none',
			client: 'claude_code',
			transport: 'http',
			auth_method: 'api_key',
			workspace_id: WORKSPACE_ID,
			agent_actor_id: ACTOR_ID,
		})
	})

	it('falls back to the workspace, then to a fixed anonymous id, never an empty one', async () => {
		await captureMcpHandshake(WORKSPACE_ID, handshake({ agentActorId: null }))
		expect(vi.mocked(capturePosthogEvent).mock.calls[0][1]).toBe(WORKSPACE_ID)

		await captureMcpHandshake('', handshake({ agentActorId: null }))
		const anonymous = vi.mocked(capturePosthogEvent).mock.calls[1][1]
		expect(anonymous).toBe(MCP_HANDSHAKE_ANONYMOUS_DISTINCT_ID)
		expect(anonymous).not.toBe('')
	})
})
