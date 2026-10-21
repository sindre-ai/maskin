/**
 * One log line and one PostHog event per Unipile webhook delivery.
 *
 * Wake latency, duplicates and coverage are read from the database (see the
 * runbook); this module is the part that makes a delivery visible in the logs
 * and countable in PostHog, including the ones that never reach the database
 * (duplicates and drops). Logs carry ids and codes only, never message text or
 * names.
 *
 * Exactly-once is the caller's job: `createDeliveryReporter` keeps one slot per
 * integration row so a late failure cannot add a second line after an outcome
 * was already reported.
 */

import { capturePosthogEvent } from '../../../analytics/posthog'
import { logger } from '../../../logger'
import type { UnipileEnvelope } from './envelope'
import { resourceId } from './event-map'

export type DeliveryOutcome = 'emitted' | 'duplicate' | 'dropped' | 'failed'

/** Dropped for a reason that is routine, so it logs at info rather than warn. */
const QUIET_DROP_REASONS = new Set(['own_message', 'flag_off', 'no_active_integration'])

export interface DeliveryReport {
	outcome: DeliveryOutcome
	/** Drop reason, "duplicate" detail or failure code. Null for emitted. */
	reason?: string | null
	/** Provider-agnostic extras from the classifier (direction_source, classification). */
	extra?: Record<string, unknown> | null
	/** Failure message, for outcome failed only. */
	error?: string
}

export interface DeliveryTarget {
	id: string
	workspaceId: string
}

function readString(
	source: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = source?.[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** Ingest time minus the provider's own timestamp, in milliseconds. Null when absent or unparseable. */
export function deliveryLatencyMs(envelope: UnipileEnvelope, nowMs: number): number | null {
	const raw = readString(envelope.resource, 'timestamp')
	if (!raw) return null
	const providerMs = Date.parse(raw)
	return Number.isFinite(providerMs) ? Math.round(nowMs - providerMs) : null
}

/**
 * Writes the delivery's log line and fires its PostHog event. The PostHog
 * event needs a workspace to attribute to, so a delivery that never reached an
 * integration row (unknown type, no active integration) is logged only.
 */
export function recordWebhookDelivery(
	envelope: UnipileEnvelope,
	mapped: boolean,
	target: DeliveryTarget | null,
	report: DeliveryReport,
	nowMs: number = Date.now(),
): void {
	const reason = report.reason ?? null
	const classification =
		readString(report.extra, 'classification') ?? readString(report.extra, 'data_classification')
	const fields = {
		event_type: envelope.type,
		integration_id: target?.id ?? null,
		account_id: envelope.accountId,
		external_id: resourceId(envelope),
		envelope_id: envelope.envelopeId,
		outcome: report.outcome,
		reason,
		classification,
		direction_source: readString(report.extra, 'direction_source'),
		latency_ms: deliveryLatencyMs(envelope, nowMs),
	}

	if (report.outcome === 'failed') {
		logger.error('linkedin-unipile webhook: delivery', { ...fields, error: report.error ?? null })
	} else if (report.outcome === 'dropped' && !QUIET_DROP_REASONS.has(reason ?? '')) {
		logger.warn('linkedin-unipile webhook: delivery', fields)
	} else {
		logger.info('linkedin-unipile webhook: delivery', fields)
	}

	if (!target) return
	void capturePosthogEvent('unipile_webhook_received', target.workspaceId, {
		event_type: envelope.type,
		mapped,
		deduped: report.outcome === 'duplicate',
		outcome: report.outcome,
		reason,
		workspace_id: target.workspaceId,
		account_id: envelope.accountId,
	})
}

export interface DeliveryReporter {
	/** Reports once per integration row (or once for the no-row case). Later calls are ignored. */
	report: (target: DeliveryTarget | null, report: DeliveryReport) => void
}

export function createDeliveryReporter(
	envelope: UnipileEnvelope,
	mapped: boolean,
): DeliveryReporter {
	const reported = new Set<string>()
	return {
		report(target, report) {
			const key = target?.id ?? ''
			if (reported.has(key)) return
			reported.add(key)
			recordWebhookDelivery(envelope, mapped, target, report)
		},
	}
}
