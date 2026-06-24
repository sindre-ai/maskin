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
})
