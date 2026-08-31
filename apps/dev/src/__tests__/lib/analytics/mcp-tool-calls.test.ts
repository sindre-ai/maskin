import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

import { argKeys, captureMcpToolCall } from '../../../lib/analytics/mcp-tool-calls'
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
})
