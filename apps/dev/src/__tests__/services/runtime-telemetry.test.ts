import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTelemetry, type TelemetryClient } from '../../services/runtime-telemetry'

function makeFakeClient(overrides: Partial<TelemetryClient> = {}) {
	const capture = vi.fn()
	const shutdown = vi.fn().mockResolvedValue(undefined)
	const client: TelemetryClient = { capture, shutdown, ...overrides }
	return { client, capture, shutdown }
}

describe('RuntimeTelemetry', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('captures runtime_session_started with the bet-spec property shape', () => {
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		telemetry.recordSessionStarted({
			sessionId: 'sess-1',
			agentServerUrl: 'local-docker',
			sessionStartLatencyMs: 1234,
		})

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith({
			distinctId: 'sess-1',
			event: 'runtime_session_started',
			properties: {
				session_id: 'sess-1',
				agent_server_url: 'local-docker',
				session_start_latency_ms: 1234,
				$process_person_profile: false,
			},
		})
	})

	it('captures runtime_session_ended with end_reason and duration_ms', () => {
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		telemetry.recordSessionEnded({
			sessionId: 'sess-2',
			endReason: 'irrecoverable',
			durationMs: 5000,
			agentServerUrl: 'local-docker',
		})

		expect(capture).toHaveBeenCalledWith({
			distinctId: 'sess-2',
			event: 'runtime_session_ended',
			properties: {
				session_id: 'sess-2',
				end_reason: 'irrecoverable',
				duration_ms: 5000,
				agent_server_url: 'local-docker',
				$process_person_profile: false,
			},
		})
	})

	it('captures runtime_cross_session_check with host_isolation_ok', () => {
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		telemetry.recordCrossSessionCheck({
			sessionId: 'sess-3',
			agentServerUrl: 'local-docker',
			hostIsolationOk: true,
		})

		expect(capture).toHaveBeenCalledWith({
			distinctId: 'sess-3',
			event: 'runtime_cross_session_check',
			properties: {
				session_id: 'sess-3',
				agent_server_url: 'local-docker',
				host_isolation_ok: true,
				$process_person_profile: false,
			},
		})
	})

	it('captures runtime_concurrent_sessions_gauge keyed by agent_server_url', () => {
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		telemetry.recordConcurrentSessionsGauge({
			agentServerUrl: 'https://agent-server-finland.maskin.internal',
			concurrentCount: 47,
		})

		expect(capture).toHaveBeenCalledWith({
			distinctId: 'https://agent-server-finland.maskin.internal',
			event: 'runtime_concurrent_sessions_gauge',
			properties: {
				agent_server_url: 'https://agent-server-finland.maskin.internal',
				concurrent_count: 47,
				$process_person_profile: false,
			},
		})
	})

	it('is a no-op when no api key and no client is provided', () => {
		const telemetry = new RuntimeTelemetry()
		// Throws nothing, captures nothing.
		expect(() =>
			telemetry.recordSessionStarted({
				sessionId: 'sess-1',
				agentServerUrl: 'local-docker',
				sessionStartLatencyMs: 1,
			}),
		).not.toThrow()
	})

	it('swallows capture errors so a broken PostHog never breaks a session', () => {
		const broken: TelemetryClient = {
			capture: () => {
				throw new Error('posthog blew up')
			},
			shutdown: vi.fn().mockResolvedValue(undefined),
		}
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client: broken })

		expect(() =>
			telemetry.recordSessionEnded({
				sessionId: 'sess-x',
				endReason: 'failed',
				durationMs: 10,
			}),
		).not.toThrow()
	})

	it('startGaugeLoop emits one event per agent-server bucket', async () => {
		vi.useFakeTimers()
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		const fetcher = vi.fn().mockResolvedValue(
			new Map([
				['local-docker', 3],
				['https://agent-server-finland.maskin.internal', 12],
			]),
		)

		telemetry.startGaugeLoop(fetcher, 60_000)
		// Immediate tick fires synchronously then again on each interval.
		await vi.advanceTimersByTimeAsync(0)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledTimes(2)
		expect(capture.mock.calls.map(([c]) => c.event)).toEqual([
			'runtime_concurrent_sessions_gauge',
			'runtime_concurrent_sessions_gauge',
		])

		await vi.advanceTimersByTimeAsync(60_000)
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(capture).toHaveBeenCalledTimes(4)

		await telemetry.shutdown()
	})

	it('gauge fetcher failure is logged but does not throw', async () => {
		vi.useFakeTimers()
		const { client } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		const fetcher = vi.fn().mockRejectedValue(new Error('db down'))
		telemetry.startGaugeLoop(fetcher, 60_000)
		await vi.advanceTimersByTimeAsync(0)
		expect(fetcher).toHaveBeenCalled()

		await telemetry.shutdown()
	})

	it('startGaugeLoop is inert when telemetry is disabled (no api key)', async () => {
		vi.useFakeTimers()
		const telemetry = new RuntimeTelemetry()

		const fetcher = vi.fn().mockResolvedValue(new Map([['local-docker', 1]]))
		telemetry.startGaugeLoop(fetcher, 60_000)
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(120_000)

		// The concurrency fetcher (a DB query in production) must never run when
		// there is no client to emit to.
		expect(fetcher).not.toHaveBeenCalled()

		await telemetry.shutdown()
	})

	it('shutdown clears the gauge interval and calls the client shutdown', async () => {
		vi.useFakeTimers()
		const { client, capture, shutdown } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		const fetcher = vi.fn().mockResolvedValue(new Map([['local-docker', 1]]))
		telemetry.startGaugeLoop(fetcher, 60_000)
		await vi.advanceTimersByTimeAsync(0)
		const calledBeforeShutdown = capture.mock.calls.length

		await telemetry.shutdown()
		expect(shutdown).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(120_000)
		// No further gauge ticks after shutdown.
		expect(capture.mock.calls.length).toBe(calledBeforeShutdown)
	})

	it('omits agent_server_url from session_ended when not provided', () => {
		const { client, capture } = makeFakeClient()
		const telemetry = new RuntimeTelemetry({ apiKey: 'phc_x', client })

		telemetry.recordSessionEnded({
			sessionId: 'sess-z',
			endReason: 'user_stopped',
			durationMs: 8,
		})

		expect(capture).toHaveBeenCalledWith({
			distinctId: 'sess-z',
			event: 'runtime_session_ended',
			properties: {
				session_id: 'sess-z',
				end_reason: 'user_stopped',
				duration_ms: 8,
				$process_person_profile: false,
			},
		})
	})

	describe('runtime_session_ended duplicate guard', () => {
		const ended = (sessionId: string) => ({
			sessionId,
			endReason: 'failed' as const,
			durationMs: 1,
		})

		it('sends one event per session however many times the end is recorded', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client })

			for (let i = 0; i < 1000; i++) telemetry.recordSessionEnded(ended('sess-loop'))

			expect(capture).toHaveBeenCalledTimes(1)
		})

		it('still sends one event for each distinct session', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client })

			telemetry.recordSessionEnded(ended('sess-a'))
			telemetry.recordSessionEnded(ended('sess-b'))
			telemetry.recordSessionEnded(ended('sess-a'))

			expect(capture.mock.calls.map(([p]) => p.distinctId)).toEqual(['sess-a', 'sess-b'])
		})

		it('does not suppress other events for the same session', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client })

			telemetry.recordSessionStarted({
				sessionId: 'sess-a',
				agentServerUrl: 'local-docker',
				sessionStartLatencyMs: 1,
			})
			telemetry.recordSessionEnded(ended('sess-a'))
			telemetry.recordSessionEnded(ended('sess-a'))

			expect(capture.mock.calls.map(([p]) => p.event)).toEqual([
				'runtime_session_started',
				'runtime_session_ended',
			])
		})

		it('forgets the oldest session once the limit is reached, so memory stays bounded', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDedupLimit: 2 })

			telemetry.recordSessionEnded(ended('sess-1'))
			telemetry.recordSessionEnded(ended('sess-2'))
			telemetry.recordSessionEnded(ended('sess-3')) // evicts sess-1
			telemetry.recordSessionEnded(ended('sess-3')) // still remembered
			telemetry.recordSessionEnded(ended('sess-1')) // forgotten, sends again

			expect(capture.mock.calls.map(([p]) => p.distinctId)).toEqual([
				'sess-1',
				'sess-2',
				'sess-3',
				'sess-1',
			])
		})

		it('sends every call when the limit is 0', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDedupLimit: 0 })

			telemetry.recordSessionEnded(ended('sess-a'))
			telemetry.recordSessionEnded(ended('sess-a'))

			expect(capture).toHaveBeenCalledTimes(2)
		})
	})

	describe('runtime_session_ended daily cap', () => {
		const ended = (sessionId: string) => ({
			sessionId,
			endReason: 'failed' as const,
			durationMs: 1,
		})

		it('stops sending once the day is full, even for new session ids', () => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-10-26T10:00:00Z'))
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDailyCap: 3 })

			for (let i = 0; i < 100; i++) telemetry.recordSessionEnded(ended(`sess-${i}`))

			expect(capture).toHaveBeenCalledTimes(3)
		})

		it('starts counting again on the next UTC day', () => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-10-26T23:59:00Z'))
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDailyCap: 2 })

			for (let i = 0; i < 5; i++) telemetry.recordSessionEnded(ended(`day1-${i}`))
			vi.setSystemTime(new Date('2026-10-27T00:01:00Z'))
			for (let i = 0; i < 5; i++) telemetry.recordSessionEnded(ended(`day2-${i}`))

			expect(capture).toHaveBeenCalledTimes(4)
		})

		it('does not cap other events', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDailyCap: 1 })

			telemetry.recordSessionEnded(ended('sess-a'))
			telemetry.recordSessionEnded(ended('sess-b'))
			telemetry.recordCrossSessionCheck({
				sessionId: 'sess-b',
				agentServerUrl: 'local-docker',
				hostIsolationOk: true,
			})

			expect(capture.mock.calls.map(([p]) => p.event)).toEqual([
				'runtime_session_ended',
				'runtime_cross_session_check',
			])
		})

		it('sends every call when the cap is 0', () => {
			const { client, capture } = makeFakeClient()
			const telemetry = new RuntimeTelemetry({ client, endedDailyCap: 0 })

			for (let i = 0; i < 10; i++) telemetry.recordSessionEnded(ended(`sess-${i}`))

			expect(capture).toHaveBeenCalledTimes(10)
		})
	})
})
