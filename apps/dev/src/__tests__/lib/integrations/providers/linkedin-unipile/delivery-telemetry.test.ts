import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerMock, captureMock } = vi.hoisted(() => ({
	loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	captureMock: vi.fn(async () => {}),
}))

vi.mock('../../../../../lib/logger', () => ({ logger: loggerMock }))
vi.mock('../../../../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import {
	createDeliveryReporter,
	deliveryLatencyMs,
	recordWebhookDelivery,
} from '../../../../../lib/integrations/providers/linkedin-unipile/delivery-telemetry'
import type { UnipileEnvelope } from '../../../../../lib/integrations/providers/linkedin-unipile/envelope'

const NOW = Date.parse('2026-10-04T10:15:31.500Z')
const TARGET = { id: 'int_1', workspaceId: 'ws_1' }

function envelope(overrides: Partial<UnipileEnvelope> = {}): UnipileEnvelope {
	return {
		type: 'message.new',
		accountId: 'acc_1',
		envelopeId: 'evt_1',
		resource: {
			id: 'msg_1',
			timestamp: '2026-10-04T10:15:29.000Z',
			text: 'message text that must never be logged',
			sender_id: 'ACoAASender',
		},
		...overrides,
	}
}

const FIELDS = [
	'event_type',
	'integration_id',
	'account_id',
	'external_id',
	'envelope_id',
	'outcome',
	'classification',
	'direction_source',
	'latency_ms',
]

function lastLine(level: 'info' | 'warn' | 'error'): Record<string, unknown> {
	const call = loggerMock[level].mock.calls.at(-1)
	if (!call) throw new Error(`no ${level} log call`)
	return call[1] as Record<string, unknown>
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('recordWebhookDelivery: the log line', () => {
	it('carries every field for an emitted delivery', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'emitted', extra: { direction_source: 'is_sender', classification: 'received' } },
			NOW,
		)
		expect(loggerMock.info).toHaveBeenCalledTimes(1)
		const line = lastLine('info')
		for (const key of FIELDS) expect(line).toHaveProperty(key)
		expect(line).toMatchObject({
			event_type: 'message.new',
			integration_id: 'int_1',
			account_id: 'acc_1',
			external_id: 'msg_1',
			envelope_id: 'evt_1',
			outcome: 'emitted',
			classification: 'received',
			direction_source: 'is_sender',
			latency_ms: 2500,
		})
	})

	it('carries every field for a duplicate, with null where the classifier never ran', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'duplicate', reason: 'duplicate' },
			NOW,
		)
		const line = lastLine('info')
		for (const key of FIELDS) expect(line).toHaveProperty(key)
		expect(line).toMatchObject({
			outcome: 'duplicate',
			reason: 'duplicate',
			classification: null,
			direction_source: null,
		})
	})

	it('carries every field for a dropped delivery with its reason, warn unless routine', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{
				outcome: 'dropped',
				reason: 'direction_unknown',
				extra: { direction_source: 'sender_id_fallback' },
			},
			NOW,
		)
		expect(loggerMock.warn).toHaveBeenCalledTimes(1)
		const line = lastLine('warn')
		for (const key of FIELDS) expect(line).toHaveProperty(key)
		expect(line).toMatchObject({
			outcome: 'dropped',
			reason: 'direction_unknown',
			direction_source: 'sender_id_fallback',
		})

		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'dropped', reason: 'own_message' },
			NOW,
		)
		expect(loggerMock.info).toHaveBeenCalledTimes(1)
		expect(loggerMock.warn).toHaveBeenCalledTimes(1)
	})

	it('carries every field for a failed delivery at error level, with the code and message', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'failed', reason: 'ECONNRESET', error: 'connection terminated' },
			NOW,
		)
		expect(loggerMock.error).toHaveBeenCalledTimes(1)
		const line = lastLine('error')
		for (const key of FIELDS) expect(line).toHaveProperty(key)
		expect(line).toMatchObject({
			outcome: 'failed',
			reason: 'ECONNRESET',
			error: 'connection terminated',
		})
	})

	it('logs ids only: no message text, name or sender id', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'emitted', extra: { direction_source: 'is_sender', chat_id: 'chat_1' } },
			NOW,
		)
		const serialized = JSON.stringify(loggerMock.info.mock.calls)
		expect(serialized).not.toContain('must never be logged')
		expect(serialized).not.toContain('ACoAASender')
		expect(serialized).not.toContain('chat_1')
	})

	it('reads classification from the classifier extras generically', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'emitted', extra: { classification: 'received_cold' } },
			NOW,
		)
		expect(lastLine('info').classification).toBe('received_cold')
	})
})

describe('deliveryLatencyMs', () => {
	it('is ingest time minus the provider timestamp', () => {
		expect(deliveryLatencyMs(envelope(), NOW)).toBe(2500)
	})

	it('is null when the timestamp is absent or unparseable', () => {
		expect(deliveryLatencyMs(envelope({ resource: { id: 'm' } }), NOW)).toBeNull()
		expect(deliveryLatencyMs(envelope({ resource: { timestamp: 'not a date' } }), NOW)).toBeNull()
		expect(deliveryLatencyMs(envelope({ resource: null }), NOW)).toBeNull()
	})
})

describe('recordWebhookDelivery: the PostHog event', () => {
	it('fires unipile_webhook_received once with the specified properties', () => {
		recordWebhookDelivery(envelope(), true, TARGET, { outcome: 'emitted' }, NOW)
		expect(captureMock).toHaveBeenCalledTimes(1)
		expect(captureMock).toHaveBeenCalledWith('unipile_webhook_received', 'ws_1', {
			event_type: 'message.new',
			mapped: true,
			deduped: false,
			outcome: 'emitted',
			reason: null,
			workspace_id: 'ws_1',
			account_id: 'acc_1',
		})
	})

	it('marks a duplicate as deduped and a drop with its reason', () => {
		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'duplicate', reason: 'duplicate' },
			NOW,
		)
		expect(captureMock.mock.calls.at(-1)?.[2]).toMatchObject({
			deduped: true,
			outcome: 'duplicate',
		})

		recordWebhookDelivery(
			envelope(),
			true,
			TARGET,
			{ outcome: 'dropped', reason: 'own_message' },
			NOW,
		)
		expect(captureMock.mock.calls.at(-1)?.[2]).toMatchObject({
			deduped: false,
			outcome: 'dropped',
			reason: 'own_message',
		})
	})

	it('does not fire when no integration row was resolved, but still logs', () => {
		recordWebhookDelivery(
			envelope(),
			false,
			null,
			{ outcome: 'dropped', reason: 'unknown_type' },
			NOW,
		)
		expect(captureMock).not.toHaveBeenCalled()
		expect(loggerMock.warn).toHaveBeenCalledTimes(1)
		expect(lastLine('warn')).toMatchObject({ integration_id: null, reason: 'unknown_type' })
	})
})

describe('createDeliveryReporter', () => {
	it('reports once per integration row and ignores later reports for the same row', () => {
		const reporter = createDeliveryReporter(envelope(), true)
		reporter.report(TARGET, { outcome: 'emitted' })
		reporter.report(TARGET, { outcome: 'failed', reason: 'late' })
		expect(loggerMock.info).toHaveBeenCalledTimes(1)
		expect(loggerMock.error).not.toHaveBeenCalled()
		expect(captureMock).toHaveBeenCalledTimes(1)

		reporter.report({ id: 'int_2', workspaceId: 'ws_1' }, { outcome: 'duplicate' })
		expect(loggerMock.info).toHaveBeenCalledTimes(2)
	})
})
