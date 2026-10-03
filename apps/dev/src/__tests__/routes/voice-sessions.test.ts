import { VOICE_ALLOWED_TOOLS } from '@maskin/mcp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Import the route module lazily so it picks up the env `beforeEach` set.
const { default: voiceSessionsRoutes, setRealtimeMintFn } = await import(
	'../../routes/voice-sessions'
)

const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES'] as const

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
	for (const key of ENV_KEYS) {
		if (vars[key] === undefined) delete process.env[key]
		else process.env[key] = vars[key]
	}
	_resetFeatureFlagConfig()
}

function enableFlagFor(actorId: string) {
	setEnv({ FF_TESTER_ACTOR_IDS: actorId, FF_TESTER_FEATURES: 'voice-mode-v1' })
}

function membershipRow() {
	return { workspaceId: WORKSPACE }
}

function agentRow(overrides?: Partial<{ metadata: unknown; type: string }>) {
	return {
		id: AGENT,
		name: 'Chief of Staff',
		type: 'agent',
		systemPrompt: 'You are the Chief of Staff.',
		metadata: { voice_enabled: true },
		...overrides,
	}
}

function stubMint(overrides?: {
	kind?: 'ok' | 'rate_limited' | 'error'
	retryAfterSeconds?: number
	status?: number
}) {
	const kind = overrides?.kind ?? 'ok'
	setRealtimeMintFn(async () => {
		if (kind === 'rate_limited') {
			return { kind: 'rate_limited', retryAfterSeconds: overrides?.retryAfterSeconds ?? 15 }
		}
		if (kind === 'error') {
			return { kind: 'error', status: overrides?.status ?? 500, body: 'boom' }
		}
		return {
			kind: 'ok',
			vendorSessionId: 'vs_test123',
			clientSecret: 'ek_test_abc',
			expiresAt: '2026-09-29T10:00:00.000Z',
			wsUrl: 'wss://api.openai.com/v1/realtime',
			model: 'gpt-realtime',
		}
	})
}

beforeEach(() => {
	setEnv({})
	setRealtimeMintFn(null) // reset to default
	process.env.MASKIN_VOICE_OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
	setEnv({})
	setRealtimeMintFn(null)
	process.env.MASKIN_VOICE_OPENAI_API_KEY = undefined
})

describe('POST /api/voice-sessions', () => {
	it('404s when the voice-mode-v1 flag is off for the caller', async () => {
		const { app } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(404)
	})

	it('404s when the target agent has no shared workspace with the caller', async () => {
		enableFlagFor(HUMAN)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			// cross-workspace: membership self-join returns no row
			[],
		]
		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(404)
	})

	it('400s when the target actor exists but is not voice-enabled', async () => {
		enableFlagFor(HUMAN)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[agentRow({ metadata: null })],
			[], // agentSkills
		]
		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('BAD_REQUEST')
	})

	it('409s on the unique-index violation when the caller already has a live session', async () => {
		enableFlagFor(HUMAN)
		stubMint({ kind: 'ok' })
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[agentRow()],
			[{ seconds: '0' }], // daily minutes used
			[], // agentSkills
		]
		// The route inserts voice_sessions first; the partial unique index on
		// (human_actor_id) fires with pg code 23505.
		const dupe = new Error('duplicate key value violates unique constraint') as Error & {
			code?: string
		}
		dupe.code = '23505'
		mockResults.insertError = dupe

		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(409)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('CONFLICT')
	})

	it('propagates 429 with retry_after_seconds from the vendor rate limit', async () => {
		enableFlagFor(HUMAN)
		stubMint({ kind: 'rate_limited', retryAfterSeconds: 42 })
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[agentRow()],
			[{ seconds: '0' }], // daily minutes used
			[], // agentSkills
		]
		mockResults.insert = [{ id: '9f8e7d6c-5b4a-4a3b-2c1d-0e9f8a7b6c5d' }]

		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(429)
		const body = (await res.json()) as {
			error: { code: string }
			retry_after_seconds: number
		}
		expect(body.error.code).toBe('RATE_LIMITED')
		expect(body.retry_after_seconds).toBe(42)
	})

	it('429s with retry_after_seconds when the workspace has used its 60 daily voice minutes', async () => {
		enableFlagFor(HUMAN)
		stubMint({ kind: 'ok' })
		const mint = vi.fn()
		setRealtimeMintFn(mint)
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [
			[membershipRow()],
			[agentRow()],
			[{ seconds: String(60 * 60) }], // daily seconds used: exactly the cap
		]

		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(429)
		const body = (await res.json()) as {
			error: { code: string }
			retry_after_seconds: number
		}
		expect(body.error.code).toBe('RATE_LIMITED')
		expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1)
		expect(body.retry_after_seconds).toBeLessThanOrEqual(24 * 60 * 60)
		// Nothing written and the vendor never called for a capped workspace.
		expect(calls.inserts).toHaveLength(0)
		expect(mint).not.toHaveBeenCalled()
	})

	it('returns 201 with the ephemeral session on the happy path', async () => {
		enableFlagFor(HUMAN)
		stubMint({ kind: 'ok' })
		const insertedId = '11111111-1111-4111-8111-111111111111'
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[agentRow()],
			[{ seconds: '0' }], // daily minutes used
			[], // agentSkills
		]
		mockResults.insert = [{ id: insertedId }]

		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			voice_session_id: string
			client_secret: string
			expires_at: string
			ws_url: string
		}
		expect(body).toEqual({
			voice_session_id: insertedId,
			client_secret: 'ek_test_abc',
			expires_at: '2026-09-29T10:00:00.000Z',
			ws_url: 'wss://api.openai.com/v1/realtime',
		})
	})

	it('pins the voice tool whitelist on the vendor session it mints', async () => {
		enableFlagFor(HUMAN)
		// Real mint function, stubbed transport: what leaves the process is what
		// OpenAI would receive.
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'sess_vendor1',
					model: 'gpt-realtime',
					client_secret: { value: 'ek_live_abc', expires_at: 1_790_000_000 },
				}),
				{ status: 200 },
			),
		)
		vi.stubGlobal('fetch', fetchMock)
		try {
			const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
			mockResults.selectQueue = [[membershipRow()], [agentRow()], [{ seconds: '0' }], []]
			mockResults.insert = [{ id: '11111111-1111-4111-8111-111111111111' }]

			const res = await app.request(
				jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
			)
			expect(res.status).toBe(201)

			const sent = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
				tools: Array<{ type: string; name: string }>
				tool_choice: string
			}
			expect(sent.tools.map((t) => t.name).sort()).toEqual([...VOICE_ALLOWED_TOOLS].sort())
			expect(sent.tools.every((t) => t.type === 'function')).toBe(true)
			expect(sent.tool_choice).toBe('auto')
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('rejects a body missing agent_actor_id with 400 VALIDATION_ERROR', async () => {
		enableFlagFor(HUMAN)
		const { app } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		const res = await app.request(jsonRequest('POST', '/api/voice-sessions', {}))
		expect(res.status).toBe(400)
	})
})
