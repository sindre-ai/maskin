import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	captureObservabilityInsightCreated,
	captureObservabilitySignalReceived,
	newSignalId,
} from '../../../lib/analytics/observability-events'

describe('observability-events', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		vi.stubEnv('POSTHOG_HOST', '')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	describe('newSignalId', () => {
		it('mints distinct UUIDs', () => {
			expect(newSignalId()).not.toBe(newSignalId())
		})
	})

	describe('captureObservabilitySignalReceived', () => {
		it('posts observability_signal_received with the canonical source enum and received_at', async () => {
			const receivedAt = new Date('2026-06-23T10:00:00.000Z')
			await captureObservabilitySignalReceived({
				signalId: 'sig-1',
				source: 'coolify_deployment_failed',
				receivedAt,
				fingerprint: 'coolify_deployment:app-1:dep-1',
			})

			expect(fetchMock).toHaveBeenCalledOnce()
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			const body = JSON.parse(init.body as string)
			expect(body.event).toBe('observability_signal_received')
			expect(body.properties.signal_id).toBe('sig-1')
			expect(body.properties.source).toBe('coolify_deployment_failed')
			expect(body.properties.received_at).toBe('2026-06-23T10:00:00.000Z')
			expect(body.properties.fingerprint).toBe('coolify_deployment:app-1:dep-1')
		})

		it('carries is_new_fingerprint for posthog_exception signals', async () => {
			await captureObservabilitySignalReceived({
				signalId: 'sig-2',
				source: 'posthog_exception',
				receivedAt: new Date('2026-06-23T10:00:00.000Z'),
				fingerprint: 'posthog_exception:fp-1',
				isNewFingerprint: true,
			})
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			const body = JSON.parse(init.body as string)
			expect(body.properties.is_new_fingerprint).toBe(true)
		})
	})

	describe('captureObservabilityInsightCreated', () => {
		it('posts observability_insight_created with signal_id FK, insight_id, source, and time_to_insight_ms', async () => {
			await captureObservabilityInsightCreated({
				workspaceId: 'ws-1',
				signalId: 'sig-1',
				source: 'coolify_application_crashed',
				insightId: 'insight-1',
				timeToInsightMs: 1234,
			})

			expect(fetchMock).toHaveBeenCalledOnce()
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			const body = JSON.parse(init.body as string)
			expect(body.event).toBe('observability_insight_created')
			expect(body.properties.signal_id).toBe('sig-1')
			expect(body.properties.insight_id).toBe('insight-1')
			expect(body.properties.source).toBe('coolify_application_crashed')
			expect(body.properties.time_to_insight_ms).toBe(1234)
			expect(body.properties.workspace_id).toBe('ws-1')
		})
	})

	it('silently no-ops when POSTHOG_API_KEY is unset', async () => {
		vi.stubEnv('POSTHOG_API_KEY', '')
		await captureObservabilitySignalReceived({
			signalId: 'sig-1',
			source: 'posthog_exception',
			receivedAt: new Date(),
			isNewFingerprint: true,
		})
		await captureObservabilityInsightCreated({
			workspaceId: 'ws-1',
			signalId: 'sig-1',
			source: 'posthog_exception',
			insightId: 'insight-1',
			timeToInsightMs: 10,
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
