import { z } from '@hono/zod-openapi'
import type { CallClientState, TelnyxClient } from '../../integrations/providers/telnyx/client'
import { logger } from '../../logger'
import {
	type DncGateDeps,
	type DncResult,
	type GateContact,
	inDialWindow,
	normalizeDanishNumber,
	runDncGate,
} from './dnc-gate'
import { copenhagenParts, copenhagenToUtc } from './workdays'

/**
 * The voice dialer: one tick reads the due queue, paces it against the rate and
 * daily caps, runs every contact through the DNC gate, claims it, and places the
 * call. Everything it touches goes through ports (store, Telnyx client, gate
 * deps, clock) so the tick is unit-tested with fakes; dialer-store.ts is the
 * Drizzle-backed store and jobs/voice-dialer.ts is the cron entrypoint.
 *
 * No in-memory counters: the rate and daily counts are read from the events
 * table (action call_initiated), so they survive a restart.
 */

/** Statuses a retrying contact sits on. The reducer never flips them back to voice_queued. */
export const RETRY_STATUSES = ['voice_no_answer', 'voice_busy', 'voice_voicemail'] as const

/** How many contacts past the pacing budget a tick may read, so refused contacts do not eat the slots. */
const LOOKAHEAD_FACTOR = 5
const MAX_QUEUE_READ = 50
const MAX_SUMMARY_IDS = 25

export const dialerConfigSchema = z.object({
	rateLimitPerMinute: z.number().int().positive(),
	dailyCap: z.number().int().positive(),
	/** Telnyx DK number the call is placed from. */
	fromNumber: z.string().min(1).nullable(),
	assistantId: z.string().min(1).nullable(),
	/** Telnyx Voice API application id (connection_id). */
	connectionId: z.string().min(1).nullable(),
	webhookUrl: z.string().url().nullable(),
})
export type DialerConfig = z.infer<typeof dialerConfigSchema>

export interface QueuedContact extends GateContact {
	/** metadata.next_dial_at exactly as read, the claim compares against it. */
	nextDialAt: string | null
}

export interface DialerEvent {
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data: Record<string, unknown>
}

/** What the queue read needs from the gate's process-level inputs to recognise a permanent refusal. */
export interface QueueExclusion {
	/**
	 * Lowercased slugs of VOICE_FOUNDER_ACTORS. Null when the map is unusable, in which case no
	 * owner is treated as unmapped (the gate refuses everyone for that, which is not per contact).
	 */
	founderSlugs: readonly string[] | null
}

export interface DialerStore {
	/**
	 * The widened queue: voice_queued (next_dial_at null or due) plus due retry statuses, minus
	 * contacts that carry a stamped dnc_refusal whose permanent cause still holds. The limit is
	 * applied after that exclusion, so refused contacts never use up the window.
	 */
	readQueue(
		workspaceId: string,
		now: Date,
		limit: number,
		exclusion: QueueExclusion,
	): Promise<QueuedContact[]>
	/**
	 * Status-conditional claim: one update that moves the contact to voice_dialing
	 * where id, status and next_dial_at still match what the tick read. False when
	 * zero rows changed (another tick took it).
	 */
	claim(workspaceId: string, contact: QueuedContact, actorId: string, now: Date): Promise<boolean>
	/** Count of call_initiated events for the workspace since the given instant. */
	countCallInitiated(workspaceId: string, since: Date): Promise<number>
	recordEvent(event: DialerEvent): Promise<void>
	/** Merges a patch into the contact's metadata. Does not touch status. */
	stampMetadata(
		workspaceId: string,
		contactId: string,
		patch: Record<string, unknown>,
	): Promise<void>
	/** Reducer rest_failure: contact to voice_failed, dead letter at Attention 5. */
	failContact(workspaceId: string, contactId: string, reason: string): Promise<void>
}

export interface DialerDeps {
	store: DialerStore
	telnyx: Pick<TelnyxClient, 'createCall'>
	/** Gate inputs other than the clock, which the tick supplies. */
	gate: Omit<DncGateDeps, 'now'>
	config: DialerConfig
	/** VOICE_OUTREACH_AUTOSEND resolved for this workspace. Off builds the queue and dials nothing. */
	autosendEnabled: boolean
	/** The Sales Rep (Voice) actor id from env. Null fails closed: no call, no event. */
	actorId: string | null
	now?: () => Date
}

export type SkippedReason =
	| 'voice_actor_not_configured'
	| 'outside_dial_window'
	| 'rate_limited'
	| 'daily_cap_reached'
	| 'autosend_off'
	| 'telnyx_not_configured'
	| 'queue_empty'

export interface DialerTickResult {
	tick_at: string
	dialed_count: number
	in_last_60s: number
	slots_remaining: number
	skipped_reason?: SkippedReason
	/** Contacts the gate refused this tick. */
	refused_count: number
	/** Contacts another tick claimed first. */
	claim_lost_count: number
	/** Autosend off only: contacts that would have been dialed (before the DNC gate). */
	ready_to_dial_count?: number
}

/** The attempt number this dial carries: what the contact has recorded, plus one. */
export function dialAttemptOf(contact: QueuedContact): number {
	const n = contact.metadata?.dial_attempt_n
	return (typeof n === 'number' && Number.isFinite(n) ? n : 0) + 1
}

/** Midnight at the start of the current Copenhagen calendar day. */
export function copenhagenMidnight(now: Date): Date {
	const p = copenhagenParts(now)
	return copenhagenToUtc(p.year, p.month, p.day, 0, 0)
}

async function emitTick(deps: DialerDeps, workspaceId: string, result: DialerTickResult) {
	if (!deps.actorId) return
	await deps.store.recordEvent({
		workspaceId,
		actorId: deps.actorId,
		action: 'dialer_tick',
		entityType: 'workspace',
		entityId: workspaceId,
		data: { ...result },
	})
}

async function refuse(
	deps: DialerDeps,
	workspaceId: string,
	actorId: string,
	contact: QueuedContact,
	refusal: Extract<DncResult, { pass: false }>,
	now: Date,
) {
	// A refused contact stays on its status. The queue read skips it once its stamp is written and
	// the permanent cause still holds (dialer-store.ts); a transient refusal is re-read every tick.
	// Write the event and the stamp once per distinct reason, not every ten seconds.
	// Time of day is not a property of the contact, so it is never stamped.
	const previous = contact.metadata?.dnc_refusal as
		| { reason?: unknown; phone?: unknown }
		| undefined
	// A Robinson match is for one number: a changed number is a new refusal, so it is stamped again.
	if (
		refusal.check !== 'time_of_day' &&
		previous?.reason === refusal.reason &&
		previous?.phone === refusal.listedNumber
	) {
		return
	}
	await deps.store.recordEvent({
		workspaceId,
		actorId,
		action: 'dnc_refused',
		entityType: 'object',
		entityId: contact.id,
		data: { check: refusal.check, reason: refusal.reason },
	})
	if (refusal.check === 'time_of_day') return
	await deps.store.stampMetadata(workspaceId, contact.id, {
		...(refusal.stamp ?? {}),
		dnc_refusal: {
			check: refusal.check,
			reason: refusal.reason,
			at: now.toISOString(),
			...(refusal.listedNumber ? { phone: refusal.listedNumber } : {}),
		},
	})
}

/**
 * One dialer tick for one workspace. Never throws for a per-contact problem; a
 * store failure (database down) propagates to the caller, which logs it.
 */
export async function runDialerTick(
	workspaceId: string,
	deps: DialerDeps,
): Promise<DialerTickResult> {
	const clock = deps.now ?? (() => new Date())
	const now = clock()
	const result: DialerTickResult = {
		tick_at: now.toISOString(),
		dialed_count: 0,
		in_last_60s: 0,
		slots_remaining: 0,
		refused_count: 0,
		claim_lost_count: 0,
	}
	const finish = async (skipped?: SkippedReason) => {
		if (skipped) result.skipped_reason = skipped
		await emitTick(deps, workspaceId, result)
		return result
	}

	const actorId = deps.actorId
	if (!actorId) {
		logger.warn('voice dialer skipped: VOICE_SALES_REP_ACTOR_ID is not configured', { workspaceId })
		result.skipped_reason = 'voice_actor_not_configured'
		return result
	}
	if (!inDialWindow(now)) return finish('outside_dial_window')

	// Pacing. Both counts come from the events table.
	const { rateLimitPerMinute, dailyCap } = deps.config
	result.in_last_60s = await deps.store.countCallInitiated(
		workspaceId,
		new Date(now.getTime() - 60_000),
	)
	const dailyCount = await deps.store.countCallInitiated(workspaceId, copenhagenMidnight(now))
	const slots = Math.min(rateLimitPerMinute - result.in_last_60s, dailyCap - dailyCount)
	result.slots_remaining = Math.max(0, slots)
	if (dailyCount >= dailyCap) return finish('daily_cap_reached')
	if (slots <= 0) return finish('rate_limited')

	const queue = await deps.store.readQueue(
		workspaceId,
		now,
		Math.min(slots * LOOKAHEAD_FACTOR, MAX_QUEUE_READ),
		{ founderSlugs: deps.gate.founders.ok ? Object.keys(deps.gate.founders.map) : null },
	)

	if (!deps.autosendEnabled) {
		// Builds the queue and says what it would dial. No gate, no claim, no call.
		result.ready_to_dial_count = Math.min(queue.length, slots)
		await deps.store.recordEvent({
			workspaceId,
			actorId,
			action: 'dialer_tick',
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				...result,
				skipped_reason: 'autosend_off',
				ready_to_dial_contact_ids: queue.slice(0, MAX_SUMMARY_IDS).map((c) => c.id),
			},
		})
		result.skipped_reason = 'autosend_off'
		return result
	}

	const { fromNumber, assistantId, connectionId, webhookUrl } = deps.config
	if (!fromNumber || !assistantId || !connectionId || !webhookUrl) {
		return finish('telnyx_not_configured')
	}
	if (queue.length === 0) return finish('queue_empty')

	for (const contact of queue) {
		if (result.dialed_count >= slots) break

		const verdict = await runDncGate(contact, { ...deps.gate, now })
		if (!verdict.pass) {
			result.refused_count++
			await refuse(deps, workspaceId, actorId, contact, verdict, now)
			continue
		}

		// Claim before dialing so a second tick cannot place a second call for the
		// same contact before call.initiated arrives.
		if (!(await deps.store.claim(workspaceId, contact, actorId, now))) {
			result.claim_lost_count++
			continue
		}

		const to = normalizeDanishNumber(contact.metadata?.phone)
		if (!to) {
			// Unreachable: the gate refuses a contact without a valid number.
			await deps.store.failContact(workspaceId, contact.id, 'no valid number after the gate passed')
			break
		}
		const clientState: CallClientState = {
			contact_id: contact.id,
			workspace_id: workspaceId,
			dial_attempt_n: dialAttemptOf(contact),
		}
		try {
			const call = await deps.telnyx.createCall({
				to,
				from: fromNumber,
				assistantId,
				connectionId,
				webhookUrl,
				clientState,
			})
			await deps.store.recordEvent({
				workspaceId,
				actorId,
				action: 'call_initiated',
				entityType: 'object',
				entityId: contact.id,
				data: {
					call_id: call.callControlId,
					call_session_id: call.callSessionId,
					dial_attempt_n: clientState.dial_attempt_n,
				},
			})
			result.dialed_count++
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err)
			logger.error('voice dialer: call create failed', {
				workspaceId,
				contactId: contact.id,
				reason,
			})
			await deps.store.failContact(workspaceId, contact.id, reason)
			// Telnyx is failing or rejecting us; do not burn through the queue behind it.
			break
		}
	}

	result.slots_remaining = Math.max(0, slots - result.dialed_count)
	return finish()
}
