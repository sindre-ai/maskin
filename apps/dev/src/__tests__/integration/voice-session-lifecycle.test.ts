import { actors, voiceSessions, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import voiceSessionsRoutes, { setVoiceInvokeToolFactory } from '../../routes/voice-sessions'
import {
	type CreateRealtimeCallFn,
	type OpenRealtimeSocketFn,
	setCreateRealtimeCallFn,
	setOpenRealtimeSocketFn,
} from '../../services/voice-realtime-call'
import {
	endVoiceSession,
	recordVoiceToolCall,
	recordVoiceTurn,
} from '../../services/voice-session-lifecycle'
import {
	VoiceSessionTimeoutSweeper,
	endAllLiveVoiceSessions,
} from '../../services/voice-session-timeout-sweeper'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: vi.fn(async () => {}),
}))

async function seedCall(
	opts: {
		status?: string
		startedAt?: Date
		timeoutAt?: Date
		endedAt?: Date
		workspaceId?: string
		humanId?: string
	} = {},
) {
	const humanId = opts.humanId ?? getTestActorId()
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Chief of Staff',
		email: null,
		metadata: { voice_enabled: true },
	})
	const ws = opts.workspaceId ? { id: opts.workspaceId } : await insertWorkspace(db, humanId)
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		.onConflictDoNothing()
	const [row] = await db
		.insert(voiceSessions)
		.values({
			workspaceId: ws.id,
			agentActorId: agent.id,
			humanActorId: humanId,
			status: opts.status ?? 'active',
			vendorSessionId: 'vs_test',
			model: 'gpt-realtime',
			startedAt: opts.startedAt ?? new Date(Date.now() - 120_000),
			timeoutAt: opts.timeoutAt ?? new Date(Date.now() + 15 * 60_000),
			endedAt: opts.endedAt,
		})
		.returning()
	if (!row) throw new Error('voice session insert failed')
	return { session: row, agent, ws, humanId }
}

const reload = async (id: string) =>
	(await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0]

describe('endVoiceSession', () => {
	it('ends a live call with reason, ended_at, audio seconds and cost, and maps reason to status', async () => {
		const { session } = await seedCall()

		const ended = await endVoiceSession(db, {
			id: session.id,
			reason: 'user_hangup',
			reportedInputAudioSeconds: 100,
			reportedOutputAudioSeconds: 30,
		})
		expect(ended).not.toBeNull()

		const row = await reload(session.id)
		expect(row?.status).toBe('ended')
		expect(row?.endedReason).toBe('user_hangup')
		expect(row?.endedAt).toBeInstanceOf(Date)
		expect(row?.inputAudioSeconds).toBe(100)
		expect(row?.outputAudioSeconds).toBe(30)
		// 100s * $0.001 + 30s * $0.004
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.22, 6)
	})

	it('lands each terminal reason in its status', async () => {
		const expected = {
			idle_timeout: 'timed_out',
			vendor_error: 'errored',
			network_error: 'ended',
			server_stop: 'ended',
		} as const
		for (const [reason, status] of Object.entries(expected)) {
			const { session } = await seedCall()
			await endVoiceSession(db, { id: session.id, reason: reason as keyof typeof expected })
			const row = await reload(session.id)
			expect(row?.status, reason).toBe(status)
			expect(row?.endedReason).toBe(reason)
		}
	})

	it('ends exactly once: a second terminal path on the same row is a no-op', async () => {
		const { session } = await seedCall()
		const [first, second] = await Promise.all([
			endVoiceSession(db, { id: session.id, reason: 'user_hangup' }),
			endVoiceSession(db, { id: session.id, reason: 'idle_timeout' }),
		])
		expect([first, second].filter(Boolean)).toHaveLength(1)
		const row = await reload(session.id)
		expect(row?.endedReason).toBe(first ? 'user_hangup' : 'idle_timeout')
	})

	it('uses audio the event channel recorded, and clamps client-reported audio to the call length', async () => {
		const { session } = await seedCall({ startedAt: new Date(Date.now() - 60_000) })
		recordVoiceTurn(session.id, { userAudioMs: 20_000, agentAudioMs: 10_000 })
		recordVoiceToolCall(session.id)

		await endVoiceSession(db, {
			id: session.id,
			reason: 'user_hangup',
			reportedInputAudioSeconds: 99_999,
		})
		const row = await reload(session.id)
		// Input: reported figure wins but cannot exceed the ~60s the call lasted.
		expect(row?.inputAudioSeconds).toBeGreaterThanOrEqual(60)
		expect(row?.inputAudioSeconds).toBeLessThanOrEqual(61)
		// Output: nothing reported, so the channel's 10s stands.
		expect(row?.outputAudioSeconds).toBe(10)
	})
})

describe('VoiceSessionTimeoutSweeper', () => {
	it('times out pending / active rows past timeout_at and leaves everything else alone', async () => {
		const past = new Date(Date.now() - 60_000)
		// One live call per human (partial unique index), so each live row gets its own.
		const humans = await Promise.all([1, 2, 3].map(() => insertActor(db)))
		const expiredActive = await seedCall({
			status: 'active',
			timeoutAt: past,
			humanId: humans[0].id,
		})
		const expiredPending = await seedCall({
			status: 'pending',
			timeoutAt: past,
			humanId: humans[1].id,
		})
		const fresh = await seedCall({ status: 'active', humanId: humans[2].id })
		const alreadyEnded = await seedCall({ status: 'ended', timeoutAt: past, endedAt: past })

		const ended = await new VoiceSessionTimeoutSweeper(db).tick()
		expect(ended).toBeGreaterThanOrEqual(2)

		for (const { session } of [expiredActive, expiredPending]) {
			const row = await reload(session.id)
			expect(row?.status).toBe('timed_out')
			expect(row?.endedReason).toBe('idle_timeout')
			expect(row?.endedAt).toBeInstanceOf(Date)
			expect(row?.totalCostUsd).not.toBeNull()
		}
		expect((await reload(fresh.session.id))?.status).toBe('active')
		const untouched = await reload(alreadyEnded.session.id)
		expect(untouched?.status).toBe('ended')
		expect(untouched?.endedReason).toBeNull()
	})

	it('is idempotent: a second tick ends nothing more', async () => {
		await seedCall({ status: 'active', timeoutAt: new Date(Date.now() - 60_000) })
		const sweeper = new VoiceSessionTimeoutSweeper(db)
		await sweeper.tick()
		expect(await sweeper.tick()).toBe(0)
	})
})

describe('endAllLiveVoiceSessions', () => {
	it('ends live rows as server_stop', async () => {
		const { session } = await seedCall()
		await endAllLiveVoiceSessions(db)
		const row = await reload(session.id)
		expect(row?.status).toBe('ended')
		expect(row?.endedReason).toBe('server_stop')
	})
})

describe('hangup route against real Postgres', () => {
	const app = () =>
		createIntegrationApp({ path: '/api/voice-sessions', module: voiceSessionsRoutes })
	const post = (path: string, body: unknown) =>
		app().request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

	it("POST /:id/hangup ends the caller's call, and a repeat hangup returns the same terminal state", async () => {
		const { session } = await seedCall()
		const first = await post(`/api/voice-sessions/${session.id}/hangup`, {
			reason: 'user_hangup',
			input_audio_seconds: 90,
			output_audio_seconds: 20,
		})
		expect(first.status).toBe(200)
		const firstBody = (await first.json()) as Record<string, unknown>
		expect(firstBody).toMatchObject({ status: 'ended', ended_reason: 'user_hangup' })
		expect(firstBody.total_cost_usd).toBeCloseTo(0.17, 6)

		const row = await reload(session.id)
		expect(row?.status).toBe('ended')
		expect(row?.endedReason).toBe('user_hangup')
		expect(row?.inputAudioSeconds).toBe(90)

		const again = await post(`/api/voice-sessions/${session.id}/hangup`, {
			reason: 'network_error',
		})
		expect(again.status).toBe(200)
		expect((await again.json()) as Record<string, unknown>).toMatchObject({
			status: 'ended',
			ended_reason: 'user_hangup',
		})
		expect((await reload(session.id))?.endedReason).toBe('user_hangup')
	})

	it("POST /:id/hangup 404s for another human's call", async () => {
		const other = await insertActor(db)
		const { session } = await seedCall({ humanId: other.id })
		const res = await post(`/api/voice-sessions/${session.id}/hangup`, { reason: 'user_hangup' })
		expect(res.status).toBe(404)
		expect((await reload(session.id))?.status).toBe('active')
	})

	describe('session mint and offer', () => {
		const okCall: CreateRealtimeCallFn = async () => ({
			kind: 'ok',
			callId: 'rtc_test',
			answerSdp: 'v=0 answer',
		})
		const openSocket: OpenRealtimeSocketFn = (_url, _key, handlers) => {
			queueMicrotask(() => handlers.onOpen())
			return { send: () => {}, close: () => {} }
		}

		beforeEach(() => {
			vi.mocked(capturePosthogEvent).mockClear()
			process.env.MASKIN_VOICE_OPENAI_API_KEY = 'test-key'
			setCreateRealtimeCallFn(okCall)
			setOpenRealtimeSocketFn(openSocket)
			setVoiceInvokeToolFactory(async () => ({
				tools: [],
				invokeTool: async () => ({ content: [] }),
				unreachableServers: [],
				close: async () => {},
			}))
		})
		afterEach(() => {
			// biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"
			delete process.env.MASKIN_VOICE_OPENAI_API_KEY
			setCreateRealtimeCallFn(null)
			setOpenRealtimeSocketFn(null)
			setVoiceInvokeToolFactory(null)
		})

		const deniedReasons = () =>
			vi
				.mocked(capturePosthogEvent)
				.mock.calls.filter(([event]) => event === 'voice_session_denied')
				.map(([, , props]) => props?.reason)

		const liveRows = async (humanId: string) =>
			(await db.select().from(voiceSessions).where(eq(voiceSessions.humanActorId, humanId))).filter(
				(r) => r.status === 'pending' || r.status === 'active',
			)

		const mint = async (agentId: string) => {
			await db.update(actors).set({ apiKey: 'ank_voice_test' }).where(eq(actors.id, agentId))
			const res = await post('/api/voice-sessions', { agent_actor_id: agentId })
			return {
				res,
				id: ((await res.clone().json()) as { voice_session_id?: string }).voice_session_id,
			}
		}

		it('409s a second concurrent mint for the same human and fires concurrent_active', async () => {
			const { agent } = await seedCall({ status: 'ended', endedAt: new Date() })

			const first = await mint(agent.id)
			expect(first.res.status).toBe(201)
			expect(await first.res.json()).not.toHaveProperty('client_secret')

			const second = await post('/api/voice-sessions', { agent_actor_id: agent.id })
			expect(second.status).toBe(409)
			expect(((await second.json()) as { error: { code: string } }).error.code).toBe('CONFLICT')
			expect(deniedReasons()).toEqual(['concurrent_active'])
			expect(await liveRows(getTestActorId())).toHaveLength(1)
		})

		it('offer returns the answer, records the call id and takes exactly one offer', async () => {
			const { agent } = await seedCall({ status: 'ended', endedAt: new Date() })
			const { id } = await mint(agent.id)

			const offer = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(offer.status).toBe(200)
			expect(await offer.json()).toMatchObject({ sdp: 'v=0 answer', tools_available: true })
			expect((await reload(id as string))?.vendorSessionId).toBe('rtc_test')

			const again = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(again.status).toBe(409)
		})

		it("offer 404s for another human's session", async () => {
			const other = await insertActor(db)
			const { session } = await seedCall({ humanId: other.id, status: 'pending' })
			await db
				.update(voiceSessions)
				.set({ vendorSessionId: null })
				.where(eq(voiceSessions.id, session.id))
			const res = await post(`/api/voice-sessions/${session.id}/offer`, { sdp: 'v=0 offer' })
			expect(res.status).toBe(404)
		})

		it('offer 404s once the minting human is no longer a workspace member', async () => {
			const { agent, ws } = await seedCall({ status: 'ended', endedAt: new Date() })
			const { id } = await mint(agent.id)
			await db
				.delete(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, ws.id),
						eq(workspaceMembers.actorId, getTestActorId()),
					),
				)
			const res = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(res.status).toBe(404)
		})

		it('does not lock the caller out when the vendor rate-limits the offer', async () => {
			const { agent } = await seedCall({ status: 'ended', endedAt: new Date() })
			const { id } = await mint(agent.id)
			setCreateRealtimeCallFn(async () => ({ kind: 'rate_limited', retryAfterSeconds: 7 }))

			const limited = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(limited.status).toBe(429)
			expect(await liveRows(getTestActorId())).toHaveLength(0)

			const retry = await mint(agent.id)
			expect(retry.res.status).toBe(201)
		})

		it('does not lock the caller out when the vendor errors, and marks the row errored', async () => {
			const { agent } = await seedCall({ status: 'ended', endedAt: new Date() })
			const { id } = await mint(agent.id)
			setCreateRealtimeCallFn(async () => ({ kind: 'error', status: 502, body: 'bad gateway' }))

			const failed = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(failed.status).toBe(500)
			expect(await liveRows(getTestActorId())).toHaveLength(0)
			const row = await reload(id as string)
			expect(row?.status).toBe('errored')
			expect(row?.endedReason).toBe('vendor_error')
			expect(row?.endedAt).toBeInstanceOf(Date)

			const retry = await mint(agent.id)
			expect(retry.res.status).toBe(201)
		})

		it('reports tools_available false when the server socket never opens', async () => {
			const { agent } = await seedCall({ status: 'ended', endedAt: new Date() })
			const { id } = await mint(agent.id)
			setOpenRealtimeSocketFn((_url, _key, handlers) => {
				queueMicrotask(() => handlers.onError(new Error('refused')))
				return { send: () => {}, close: () => {} }
			})

			const offer = await post(`/api/voice-sessions/${id}/offer`, { sdp: 'v=0 offer' })
			expect(offer.status).toBe(200)
			expect(await offer.json()).toMatchObject({ tools_available: false })
		})
	})
})
