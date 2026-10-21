import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: voiceSessionsRoutes } = await import('../../routes/voice-sessions')

const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const OTHER_HUMAN = '7d0f5c6e-df81-4365-8fa2-9e4b1f35c886'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const SESSION_ID = '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664'

function setFlag(on: boolean) {
	if (on) {
		process.env.FF_TESTER_ACTOR_IDS = HUMAN
		process.env.FF_TESTER_FEATURES = 'voice-mode-v1'
	} else {
		process.env.FF_TESTER_ACTOR_IDS = undefined
		process.env.FF_TESTER_FEATURES = undefined
		// biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"
		delete process.env.FF_TESTER_ACTOR_IDS
		// biome-ignore lint/performance/noDelete: same
		delete process.env.FF_TESTER_FEATURES
	}
	_resetFeatureFlagConfig()
}

const startedAt = new Date(Date.now() - 90_000)

const row = (overrides: Record<string, unknown> = {}) => ({
	id: SESSION_ID,
	workspaceId: WORKSPACE,
	agentActorId: AGENT,
	humanActorId: HUMAN,
	conversationId: null,
	status: 'active',
	vendor: 'openai_realtime',
	vendorSessionId: 'vs_1',
	model: 'gpt-realtime',
	endedReason: null,
	startedAt,
	endedAt: null,
	totalCostUsd: null,
	...overrides,
})

const hangup = (app: ReturnType<typeof createTestApp>['app'], body: unknown, id = SESSION_ID) =>
	app.request(jsonRequest('POST', `/api/voice-sessions/${id}/hangup`, body))

beforeEach(() => setFlag(true))
afterEach(() => setFlag(false))

describe('POST /api/voice-sessions/:id/hangup', () => {
	it('404s when the voice-mode-v1 flag is off for the caller', async () => {
		setFlag(false)
		const { app } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		expect((await hangup(app, { reason: 'user_hangup' })).status).toBe(404)
	})

	it('404s for a session that belongs to another human', async () => {
		const { app, mockResults } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		mockResults.selectQueue = [[row({ humanActorId: OTHER_HUMAN })]]
		expect((await hangup(app, { reason: 'user_hangup' })).status).toBe(404)
	})

	it('400s on a reason outside user_hangup / network_error', async () => {
		const { app } = createTestApp(voiceSessionsRoutes, '/api/voice-sessions', HUMAN)
		expect((await hangup(app, { reason: 'idle_timeout' })).status).toBe(400)
	})

	it('ends a live call and reports its terminal state and cost', async () => {
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		const endedAt = new Date()
		mockResults.selectQueue = [
			[row()], // route: load the session
			[{ startedAt }], // endVoiceSession: confirm it is still live
			[{ name: 'Chief of Staff' }], // voice_session_ended: agent name
		]
		mockResults.update = [
			row({
				status: 'ended',
				endedReason: 'user_hangup',
				endedAt,
				totalCostUsd: '0.130000',
			}),
		]

		const res = await hangup(app, {
			reason: 'user_hangup',
			input_audio_seconds: 60,
			output_audio_seconds: 20,
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			voice_session_id: SESSION_ID,
			status: 'ended',
			ended_reason: 'user_hangup',
			total_cost_usd: 0.13,
			conversation_id: null,
		})

		// 60s in * $0.001 + 20s out * $0.004 = $0.14; what the route wrote is the
		// source of truth, not the mocked returning().
		expect(calls.updates[0]).toMatchObject({
			status: 'ended',
			endedReason: 'user_hangup',
			inputAudioSeconds: 60,
			outputAudioSeconds: 20,
			totalCostUsd: '0.140000',
		})
	})

	it('is idempotent: a call that already ended returns its stored state and writes nothing', async () => {
		const { app, mockResults, calls } = createTestApp(
			voiceSessionsRoutes,
			'/api/voice-sessions',
			HUMAN,
		)
		const endedAt = new Date(startedAt.getTime() + 60_000)
		mockResults.selectQueue = [
			[row({ status: 'ended', endedReason: 'idle_timeout', endedAt, totalCostUsd: '0.010000' })],
		]
		const res = await hangup(app, { reason: 'user_hangup' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			status: 'ended',
			ended_reason: 'idle_timeout',
			duration_ms: 60_000,
		})
		expect(calls.updates).toHaveLength(0)
	})
})
