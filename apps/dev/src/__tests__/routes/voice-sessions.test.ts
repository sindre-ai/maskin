import { hashApiKey } from '@maskin/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Import the route module lazily so it picks up the env `beforeEach` set.
const { default: voiceSessionsRoutes, setVoiceInvokeToolFactory } = await import(
	'../../routes/voice-sessions'
)
const { setCreateRealtimeCallFn, setOpenRealtimeSocketFn } = await import(
	'../../services/voice-realtime-call'
)

const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

const VOICE_TOOLS = [
	{
		type: 'function' as const,
		name: 'list_objects',
		description: 'List objects',
		parameters: { type: 'object', properties: { cursor: { type: 'string' } } },
	},
]

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

beforeEach(() => {
	process.env.MASKIN_VOICE_OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
	setCreateRealtimeCallFn(null)
	setOpenRealtimeSocketFn(null)
	setVoiceInvokeToolFactory(null)
	vi.unstubAllGlobals()
	process.env.MASKIN_VOICE_OPENAI_API_KEY = undefined
})

describe('POST /api/voice-sessions', () => {
	it('404s when the target agent has no shared workspace with the caller', async () => {
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

	it('400s when the target actor is not an agent', async () => {
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[{ role: 'member' }],
			[agentRow({ type: 'human' })],
		]
		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('BAD_REQUEST')
	})

	it('409s on the unique-index violation when the caller already has a live session', async () => {
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[{ role: 'member' }], // writer-role check
			[agentRow()],
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

	it('returns 201 with only the session id: no vendor credential leaves the server', async () => {
		const insertedId = '11111111-1111-4111-8111-111111111111'
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[membershipRow()],
			[{ role: 'member' }], // writer-role check
			[agentRow()],
		]
		mockResults.insert = [{ id: insertedId }]

		const res = await app.request(
			jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
		)
		expect(res.status).toBe(201)
		expect(await res.json()).toEqual({ voice_session_id: insertedId })
	})

	describe('when started from a chat', () => {
		const CHAT = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'
		const insertedId = '11111111-1111-4111-8111-111111111111'

		function setup(chatRows: unknown[]) {
			const made = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
			made.mockResults.selectQueue = [
				[membershipRow()],
				[{ role: 'member' }], // writer-role check
				[agentRow()],
				chatRows, // is the caller in the chat?
			]
			made.mockResults.insert = [{ id: insertedId }]
			return made
		}

		it('stores the chat on the session when the caller is a participant', async () => {
			const { app, calls } = setup([{ id: CHAT }])
			const res = await app.request(
				jsonRequest('POST', '/api/voice-sessions', {
					agent_actor_id: AGENT,
					conversation_id: CHAT,
				}),
			)
			expect(res.status).toBe(201)
			expect(calls.inserts[0]).toMatchObject({ conversationId: CHAT })
		})

		it('ignores a chat the caller is not in, and still reserves the call', async () => {
			const { app, calls } = setup([])
			const res = await app.request(
				jsonRequest('POST', '/api/voice-sessions', {
					agent_actor_id: AGENT,
					conversation_id: CHAT,
				}),
			)
			expect(res.status).toBe(201)
			expect(calls.inserts[0]).toMatchObject({ conversationId: null })
		})

		it('stores no chat when none is sent', async () => {
			const made = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
			made.mockResults.selectQueue = [[membershipRow()], [{ role: 'member' }], [agentRow()]]
			made.mockResults.insert = [{ id: insertedId }]
			const res = await made.app.request(
				jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: AGENT }),
			)
			expect(res.status).toBe(201)
			expect(made.calls.inserts[0]).toMatchObject({ conversationId: null })
		})

		it('rejects a conversation_id that is not a uuid', async () => {
			const { app } = setup([])
			const res = await app.request(
				jsonRequest('POST', '/api/voice-sessions', {
					agent_actor_id: AGENT,
					conversation_id: 'not-a-uuid',
				}),
			)
			expect(res.status).toBe(400)
		})
	})

	it('rejects a body missing agent_actor_id with 400 VALIDATION_ERROR', async () => {
		const { app } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		const res = await app.request(jsonRequest('POST', '/api/voice-sessions', {}))
		expect(res.status).toBe(400)
	})
})

describe('POST /api/voice-sessions/:id/offer', () => {
	const SESSION = '9f8e7d6c-5b4a-4a3b-2c1d-0e9f8a7b6c5d'
	const OFFER = { sdp: 'v=0 browser offer' }

	function sessionRow(overrides?: Record<string, unknown>) {
		return {
			id: SESSION,
			workspaceId: WORKSPACE,
			agentActorId: AGENT,
			humanActorId: HUMAN,
			status: 'pending',
			vendorSessionId: null,
			conversationId: null,
			...overrides,
		}
	}
	const memberRow = () => ({ role: 'member' })
	const offerAgent = () => ({
		name: 'Chief of Staff',
		systemPrompt: 'You are the Chief of Staff.',
		tools: null,
	})
	const post = (app: { request: (r: Request) => Response | Promise<Response> }) =>
		app.request(jsonRequest('POST', `/api/voice-sessions/${SESSION}/offer`, OFFER))

	function openSocketImmediately() {
		setOpenRealtimeSocketFn((_url, _key, handlers) => {
			queueMicrotask(() => handlers.onOpen())
			return { send: vi.fn(), close: vi.fn() }
		})
	}

	it("404s for another human's session", async () => {
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [[sessionRow({ humanActorId: 'someone-else' })]]
		expect((await post(app)).status).toBe(404)
	})

	it('404s when the minting human is no longer a member of the workspace', async () => {
		const createCall = vi.fn()
		setCreateRealtimeCallFn(createCall)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [[sessionRow()], []]
		expect((await post(app)).status).toBe(404)
		expect(createCall).not.toHaveBeenCalled()
	})

	it('409s a session that already took an offer', async () => {
		const createCall = vi.fn()
		setCreateRealtimeCallFn(createCall)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [[sessionRow({ vendorSessionId: 'rtc_first' })], [memberRow()]]
		expect((await post(app)).status).toBe(409)
		expect(createCall).not.toHaveBeenCalled()
	})

	it('409s and never calls the vendor when a concurrent offer won the claim', async () => {
		const createCall = vi.fn()
		setCreateRealtimeCallFn(createCall)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [[sessionRow()], [memberRow()], [offerAgent()]]
		mockResults.update = [] // the claim UPDATE matched no row
		expect((await post(app)).status).toBe(409)
		expect(createCall).not.toHaveBeenCalled()
	})

	it('500s and mints no key when the voice agent row is gone', async () => {
		const createCall = vi.fn()
		setCreateRealtimeCallFn(createCall)
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [[sessionRow()], [memberRow()], []]

		expect((await post(app)).status).toBe(500)
		expect(createCall).not.toHaveBeenCalled()
		expect(calls.inserts).toHaveLength(0)
		expect(calls.updates).toContainEqual(expect.objectContaining({ status: 'errored' }))
	})

	it("runs the agent's tools on a short-lived key minted for the call, stored only as a hash", async () => {
		openSocketImmediately()
		setCreateRealtimeCallFn(async () => ({
			kind: 'ok',
			callId: 'rtc_abc',
			answerSdp: 'v=0 answer',
		}))
		const factory = vi.fn(async (_args: { apiKey: string }) => ({
			tools: VOICE_TOOLS,
			invokeTool: vi.fn(),
			readOnlyTools: new Set<string>(),
			unreachableServers: [],
			close: async () => {},
		}))
		setVoiceInvokeToolFactory(factory as never)
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [
			[sessionRow()],
			[memberRow()],
			[offerAgent()],
			[], // agentSkills
			[{ settings: null }], // transcript persistence
		]
		mockResults.update = [{ id: SESSION }]

		const before = Date.now()
		const res = await post(app)
		expect(res.status).toBe(200)

		const agentKey = factory.mock.calls[0]?.[0].apiKey ?? ''
		expect(agentKey).toMatch(/^ank_/)
		const keyInsert = calls.inserts.find((v) => (v as { kind?: string }).kind === 'session') as {
			actorId: string
			keyHash: string
			expiresAt: Date
		}
		expect(keyInsert).toMatchObject({ actorId: AGENT, keyHash: hashApiKey(agentKey) })
		// Two hours, give or take the time the request took.
		const ttlMs = keyInsert.expiresAt.getTime() - before
		expect(ttlMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 60_000)
		expect(ttlMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 60_000)
		expect(JSON.stringify(calls.inserts)).not.toContain(agentKey)
	})

	it('sends the offer to the GA calls endpoint with the pinned model and the full MCP tool list', async () => {
		openSocketImmediately()
		setVoiceInvokeToolFactory(async () => ({
			tools: VOICE_TOOLS,
			invokeTool: vi.fn(),
			readOnlyTools: new Set(['list_objects']),
			unreachableServers: [],
			close: async () => {},
		}))
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('v=0 vendor answer', {
				status: 201,
				headers: { location: '/v1/realtime/calls/rtc_abc' },
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[sessionRow()],
			[memberRow()],
			[offerAgent()],
			[], // agentSkills
			[{ settings: null }], // transcript persistence
		]
		mockResults.update = [{ id: SESSION }]

		const res = await post(app)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			sdp: 'v=0 vendor answer',
			tools_available: true,
			persist_transcripts: true,
		})

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.openai.com/v1/realtime/calls')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer test-key')
		expect(headers['OpenAI-Beta']).toBeUndefined()
		const form = init.body as FormData
		expect(form.get('sdp')).toBe(OFFER.sdp)
		const sent = JSON.parse(form.get('session') as string) as {
			type: string
			model: string
			tools: Array<{ type: string; name: string }>
			tool_choice: string
		}
		expect(sent.type).toBe('realtime')
		expect(sent.model).toBe('gpt-realtime-2.1')
		expect(sent.tools).toEqual(VOICE_TOOLS)
		expect(sent.tool_choice).toBe('auto')
	})

	describe('when the session was started from a chat', () => {
		const CHAT = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'

		async function offerWithChat(opts: { callerStillInChat: boolean }) {
			openSocketImmediately()
			setVoiceInvokeToolFactory(async () => ({
				tools: VOICE_TOOLS,
				invokeTool: vi.fn(),
				readOnlyTools: new Set<string>(),
				unreachableServers: [],
				close: async () => {},
			}))
			const fetchMock = vi.fn().mockResolvedValue(
				new Response('v=0 vendor answer', {
					status: 201,
					headers: { location: '/v1/realtime/calls/rtc_abc' },
				}),
			)
			vi.stubGlobal('fetch', fetchMock)
			const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
			mockResults.selectQueue = [
				[sessionRow({ conversationId: CHAT })],
				[memberRow()],
				[offerAgent()],
				[], // agentSkills
				opts.callerStillInChat ? [{ id: CHAT }] : [],
				...(opts.callerStillInChat
					? [
							[
								// newest first, as the query returns them
								{ speaker: 'Chief of Staff', content: 'Sounds good, I will book it.' },
								{ speaker: 'Sam', content: 'Lets move the launch review to Thursday 14:00.' },
							],
						]
					: []),
				[{ settings: null }], // transcript persistence
			]
			mockResults.update = [{ id: SESSION }]
			const res = await post(app)
			const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData
			const sent = JSON.parse(form.get('session') as string) as { instructions: string }
			return { res, instructions: sent.instructions }
		}

		it("adds the chat's recent messages, oldest first, to the call instructions", async () => {
			const { res, instructions } = await offerWithChat({ callerStillInChat: true })
			expect(res.status).toBe(200)
			expect(instructions).toContain('You are the Chief of Staff.')
			expect(instructions).toContain('## Earlier in this chat')
			expect(instructions).toContain('Do not ask for a yes before such a call')
			expect(instructions).toContain('How to speak on this call')
			const sam = instructions.indexOf('Sam: Lets move the launch review to Thursday 14:00.')
			const cos = instructions.indexOf('Chief of Staff: Sounds good, I will book it.')
			expect(sam).toBeGreaterThan(-1)
			expect(cos).toBeGreaterThan(sam)
		})

		it('leaves the history out when the caller has left the chat since the call was reserved', async () => {
			const { res, instructions } = await offerWithChat({ callerStillInChat: false })
			expect(res.status).toBe(200)
			expect(instructions).not.toContain('Earlier in this chat')
		})
	})

	it('reports tools_available false when the server socket cannot attach', async () => {
		setCreateRealtimeCallFn(async () => ({
			kind: 'ok',
			callId: 'rtc_abc',
			answerSdp: 'v=0 answer',
		}))
		setOpenRealtimeSocketFn((_url, _key, handlers) => {
			queueMicrotask(() => handlers.onError(new Error('refused')))
			return { send: vi.fn(), close: vi.fn() }
		})
		setVoiceInvokeToolFactory(async () => ({
			tools: VOICE_TOOLS,
			invokeTool: vi.fn(),
			readOnlyTools: new Set<string>(),
			unreachableServers: [],
			close: async () => {},
		}))
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [
			[sessionRow()],
			[memberRow()],
			[offerAgent()],
			[],
			[{ settings: null }],
		]
		mockResults.update = [{ id: SESSION }]

		const res = await post(app)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ tools_available: false })
	})

	it('propagates 429 with retry_after_seconds from the vendor rate limit and releases the row', async () => {
		setCreateRealtimeCallFn(async () => ({ kind: 'rate_limited', retryAfterSeconds: 42 }))
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [[sessionRow()], [memberRow()], [offerAgent()], []]
		mockResults.update = [{ id: SESSION }]

		const res = await post(app)
		expect(res.status).toBe(429)
		const body = (await res.json()) as {
			error: { message: string }
			retry_after_seconds: number
		}
		expect(body.retry_after_seconds).toBe(42)
		expect(body.error.message).toBe('Voice is busy at OpenAI, try again in 42 seconds')
		expect(calls.updates).toContainEqual(expect.objectContaining({ status: 'errored' }))
	})

	it('tells the caller voice is unavailable, not rate limited, when the vendor 429 is a quota error', async () => {
		setCreateRealtimeCallFn(async () => ({
			kind: 'quota_exhausted',
			vendorBody: '{"error":{"code":"insufficient_quota"}}',
		}))
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [[sessionRow()], [memberRow()], [offerAgent()], []]
		mockResults.update = [{ id: SESSION }]

		const res = await post(app)
		expect(res.status).toBe(500)
		const body = (await res.json()) as { error: { message: string }; retry_after_seconds?: number }
		expect(body.error.message).toBe('Voice is unavailable, the team has been notified')
		expect(body.retry_after_seconds).toBeUndefined()
		expect(calls.updates).toContainEqual(expect.objectContaining({ status: 'errored' }))
	})

	it('500s with a clear message and releases the row when the operator key is unset', async () => {
		process.env.MASKIN_VOICE_OPENAI_API_KEY = ''
		const createCall = vi.fn()
		setCreateRealtimeCallFn(createCall)
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [[sessionRow()], [memberRow()]]

		const res = await post(app)
		expect(res.status).toBe(500)
		expect(JSON.stringify(await res.json())).toContain('Voice is not configured')
		expect(createCall).not.toHaveBeenCalled()
		expect(calls.updates).toContainEqual(expect.objectContaining({ status: 'errored' }))
	})

	it('500s and releases the row when the vendor connect fails', async () => {
		setCreateRealtimeCallFn(async () => ({ kind: 'error', status: 502, body: 'bad gateway' }))
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		mockResults.selectQueue = [[sessionRow()], [memberRow()], [offerAgent()], []]
		mockResults.update = [{ id: SESSION }]

		const res = await post(app)
		expect(res.status).toBe(500)
		expect(calls.updates).toContainEqual(
			expect.objectContaining({ status: 'errored', endedReason: 'vendor_error' }),
		)
	})
})
