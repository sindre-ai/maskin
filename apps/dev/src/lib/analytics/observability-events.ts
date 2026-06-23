import { randomUUID } from 'node:crypto'
import { type PosthogEventProps, capturePosthogEvent } from './posthog'

/**
 * Canonical `source` enum from the parent bet's `metadata.posthog_query`.
 * The HogQL coverage rollup filters on exactly these literal values, so
 * the emit-site has to match — even though T1's internal `metadata.source`
 * uses the shorter form (`coolify_deployment` etc.) that T3's trigger keys
 * on. We map between the two only here; T1's contract stays intact.
 */
export type ObservabilitySource =
	| 'coolify_deployment_failed'
	| 'coolify_application_crashed'
	| 'coolify_health_check_failed'
	| 'posthog_exception'

const POSTHOG_DISTINCT_ID = 'maskin-observability'

/**
 * Mint a `signal_id` per webhook delivery. The Coolify route fans out one
 * insight per active integration; the bet's HogQL joins
 * `observability_insight_created` back to `observability_signal_received`
 * on this id, so all fan-out children must share their parent's id.
 */
export function newSignalId(): string {
	return randomUUID()
}

export interface SignalReceivedProps {
	workspaceId?: string
	signalId: string
	source: ObservabilitySource
	receivedAt: Date
	/** posthog_exception only — PostHog's stable issue fingerprint. */
	fingerprint?: string
	/**
	 * posthog_exception only — true when this fingerprint has no live insight
	 * within the 14d dedupe window. The bet's HogQL denominator filters
	 * `is_new_fingerprint=true` so AC-T5 dedupe occurrences are excluded.
	 */
	isNewFingerprint?: boolean
}

export interface InsightCreatedProps {
	workspaceId: string
	signalId: string
	source: ObservabilitySource
	insightId: string
	/** `created_at - received_at` in milliseconds. The bet's ship metric is the
	 *  share of signals whose `time_to_insight_ms <= 300_000` (5 minutes). */
	timeToInsightMs: number
}

/**
 * Emit `observability_signal_received`. Fired once per accepted webhook
 * delivery — before the per-workspace fan-out, so a single physical signal
 * produces exactly one row in the HogQL `events` denominator.
 */
export async function captureObservabilitySignalReceived(
	props: SignalReceivedProps,
): Promise<void> {
	const properties: PosthogEventProps = {
		signal_id: props.signalId,
		source: props.source,
		received_at: props.receivedAt.toISOString(),
		fingerprint: props.fingerprint,
		is_new_fingerprint: props.isNewFingerprint,
		workspace_id: props.workspaceId,
	}
	await capturePosthogEvent('observability_signal_received', POSTHOG_DISTINCT_ID, properties)
}

/**
 * Emit `observability_insight_created`. Fired once per workspace fan-out
 * that actually wrote a new insight — dedupe-only updates are excluded by
 * design so the HogQL latency numerator stays a per-signal MIN.
 */
export async function captureObservabilityInsightCreated(
	props: InsightCreatedProps,
): Promise<void> {
	const properties: PosthogEventProps = {
		signal_id: props.signalId,
		source: props.source,
		insight_id: props.insightId,
		time_to_insight_ms: props.timeToInsightMs,
		workspace_id: props.workspaceId,
	}
	await capturePosthogEvent('observability_insight_created', POSTHOG_DISTINCT_ID, properties)
}
