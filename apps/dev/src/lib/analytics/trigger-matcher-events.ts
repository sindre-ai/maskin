import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/**
 * Short labels attached to `trigger_match_failed` so the bet #8 dashboard can
 * separate a genuinely-dead trigger (`array_value_mismatch` / `array_empty`)
 * from a scalar mismatch on a healthy trigger from a missing hydration path.
 * Kept as string-literal union so downstream PostHog filters can autocomplete.
 */
export type MatcherMissShape =
	| 'array_value_mismatch'
	| 'scalar_mismatch'
	| 'path_missing'
	| 'array_empty'

/**
 * Shape of an individual filter entry the API-layer write-time warning flags.
 * A filter value that is a non-array object or `null` is almost always a
 * config the matcher will never resolve — bet #8's whole point is to surface
 * these at write time instead of letting them sit dead in the runtime.
 */
export type SuspiciousFilterShape = 'object_value' | 'null_value'

export interface TriggerMatchFailedProps {
	workspaceId: string
	triggerId: string
	eventId: string
	filterShape: MatcherMissShape
}

/**
 * Fires once per matcher miss when `trigger_engine_v2` is enabled for the
 * workspace. The bet's Won criteria pivot on this event — a workspace's dead
 * triggers show up as sustained rows here, and disappear once the matcher v2
 * flag reactivates them. Distinct id is the workspace so per-workspace
 * frequency lines up with the flag's rollout scope.
 *
 * Best-effort: any capture failure is swallowed so analytics never blocks
 * dispatch.
 */
export async function trackTriggerMatchFailed(p: TriggerMatchFailedProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_match_failed', p.workspaceId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
			event_id: p.eventId,
			filter_shape: p.filterShape,
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_match_failed', {
			triggerId: p.triggerId,
			eventId: p.eventId,
			filterShape: p.filterShape,
			error: String(err),
		})
	}
}

export interface TriggerConfigSuspiciousProps {
	workspaceId: string
	triggerId: string
	actorId: string
	filterKey: string
	filterShape: SuspiciousFilterShape
}

/**
 * Emitted by the triggers create/update route when a saved filter entry has a
 * value the matcher will never resolve (a non-array object or `null`). Fires
 * once per suspicious entry. Non-blocking: `triggers.config` is `jsonb`, and
 * breaking on save could strand triggers whose author already relied on the
 * config being writable (tech spec §2.3, last paragraph).
 */
export async function trackTriggerConfigSuspicious(p: TriggerConfigSuspiciousProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_config_suspicious', p.actorId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
			actor_id: p.actorId,
			filter_key: p.filterKey,
			filter_shape: p.filterShape,
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_config_suspicious', {
			triggerId: p.triggerId,
			filterKey: p.filterKey,
			filterShape: p.filterShape,
			error: String(err),
		})
	}
}

/**
 * Enumerates every suspicious entry in a trigger's `filter` map. A value that
 * is a plain (non-array) object or `null` is flagged; scalars and arrays are
 * left alone. Exported so the triggers route can iterate and emit one PostHog
 * row per suspicious entry, and so tests can pin the shape without booting
 * the route.
 */
export function detectSuspiciousFilterEntries(
	filter: Record<string, unknown> | null | undefined,
): Array<{ key: string; shape: SuspiciousFilterShape }> {
	if (!filter || typeof filter !== 'object') return []
	const out: Array<{ key: string; shape: SuspiciousFilterShape }> = []
	for (const [key, value] of Object.entries(filter)) {
		if (value === null) {
			out.push({ key, shape: 'null_value' })
			continue
		}
		if (typeof value === 'object' && !Array.isArray(value)) {
			out.push({ key, shape: 'object_value' })
		}
	}
	return out
}
