import { z } from '@hono/zod-openapi'
import { logger } from '../../logger'
import type { DialerEvent } from './dialer'
import type { EffectContext } from './effects'

/**
 * Stale-claim sweep. The dialer claims a contact (voice_dialing) before it calls
 * Telnyx, and only the call.initiated webhook moves the contact on. If that
 * webhook never arrives, or calls.create dies between the claim and the webhook,
 * the contact sits in voice_dialing for ever and nothing redials it.
 *
 * This sweep ends such a contact in voice_failed, with a legible reason and an
 * event. It NEVER moves a contact to voice_queued or any retry status, so it can
 * never cause a second dial: the failure stays a missed call, never a wrong one.
 * dial_attempt_n is left as the claim wrote it.
 *
 * "The webhook arrived" is read from the reducer's own audit row (source
 * telnyx_webhook, voice_event call_initiated) after the contact's latest claim
 * event, not from the dialer's own call_initiated event, which is written right
 * after calls.create succeeds and so exists for exactly the contacts that are
 * stuck. The sweep's own event carries a different source and never a
 * voice_event, so the next run cannot read it as webhook arrival.
 *
 * Known behaviour: voice_failed is not absorbing, so a call.initiated that lands
 * after the sweep moves the contact back to voice_dialing (the call was placed,
 * so that is the true state). That cannot cause a redial and the next run skips
 * the contact, because the webhook row is now after the claim.
 *
 * Everything goes through ports (store, alert, clock) so it is unit-tested with
 * fakes; stale-claim-store.ts is the Drizzle store and
 * jobs/voice-stale-claim-sweep.ts is the cron entrypoint.
 */

export const SWEEP_EVENT_SOURCE = 'voice_stale_claim_sweep'
export const SWEEP_END_REASON = 'claim_unconfirmed'
export const SWEEP_REASON = 'claim never confirmed by a call.initiated webhook'

/** Long enough that a slow but real call.initiated is not swept. */
export const DEFAULT_STALE_CLAIM_MINUTES = 15

const MAX_SUMMARY_IDS = 25

const staleClaimMinutesSchema = z.coerce.number().int().positive()

/** VOICE_STALE_CLAIM_MINUTES, Zod-parsed. Unset, empty or invalid falls back to the default. */
export function readStaleClaimMinutes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.VOICE_STALE_CLAIM_MINUTES
	if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_CLAIM_MINUTES
	const parsed = staleClaimMinutesSchema.safeParse(raw)
	if (parsed.success) return parsed.data
	logger.warn('voice stale-claim sweep: invalid VOICE_STALE_CLAIM_MINUTES, using the default', {
		value: raw,
		fallbackMinutes: DEFAULT_STALE_CLAIM_MINUTES,
	})
	return DEFAULT_STALE_CLAIM_MINUTES
}

export interface DialingContact {
	workspaceId: string
	contactId: string
	/** When the latest claim was written. The object's updated_at when no claim event exists. */
	claimedAt: Date
	claimSource: 'claim_event' | 'updated_at'
	/** Id of the latest voice_dialer_claim event, null when claimSource is updated_at. */
	claimEventId: number | null
	/** A telnyx_webhook call_initiated row exists after the claim: the reducer has the contact. */
	webhookAfterClaim: boolean
	dialAttemptN: number
}

export interface StaleClaimStore {
	/** Every contact in voice_dialing, across workspaces, with the facts the sweep decides on. */
	readDialing(): Promise<DialingContact[]>
	/**
	 * Status-conditional sweep: contact to voice_failed (voice_end_reason
	 * claim_unconfirmed) and its event, in one transaction, only where the contact
	 * is still voice_dialing and still has no webhook row after the claim. False
	 * when nothing changed, so a webhook that lands mid-sweep wins.
	 */
	sweep(
		contact: DialingContact,
		actorId: string,
		now: Date,
		thresholdMinutes: number,
	): Promise<boolean>
	recordEvent(event: DialerEvent): Promise<void>
}

export interface StaleClaimDeps {
	store: StaleClaimStore
	thresholdMinutes: number
	/** The Sales Rep (Voice) actor id from env. Null fails closed: nothing is swept, no event. */
	actorId: string | null
	/** Dead letter at Attention 5 to #sales, the same mechanism as the dialer's 5xx dead letter. */
	deadLetter: (ctx: EffectContext, reason: string) => Promise<void>
	now?: () => Date
}

export interface StaleClaimWorkspaceResult {
	workspaceId: string
	examined_count: number
	swept_count: number
	swept_contact_ids: string[]
	/** A webhook row exists after the claim. */
	confirmed_count: number
	/** Claim younger than the threshold. */
	fresh_count: number
	/** The conditional write changed zero rows. */
	lost_count: number
}

export interface StaleClaimSweepResult {
	sweep_at: string
	examined_count: number
	swept_count: number
	workspaces: StaleClaimWorkspaceResult[]
}

/**
 * One sweep run over every workspace. Never throws for a per-contact problem; a
 * store failure (database down) propagates to the caller, which logs it.
 */
export async function runStaleClaimSweep(deps: StaleClaimDeps): Promise<StaleClaimSweepResult> {
	const now = (deps.now ?? (() => new Date()))()
	const result: StaleClaimSweepResult = {
		sweep_at: now.toISOString(),
		examined_count: 0,
		swept_count: 0,
		workspaces: [],
	}
	const actorId = deps.actorId
	if (!actorId) {
		logger.warn('voice stale-claim sweep skipped: VOICE_SALES_REP_ACTOR_ID is not configured')
		return result
	}

	const thresholdMs = deps.thresholdMinutes * 60_000
	const byWorkspace = new Map<string, DialingContact[]>()
	for (const c of await deps.store.readDialing()) {
		const list = byWorkspace.get(c.workspaceId) ?? []
		list.push(c)
		byWorkspace.set(c.workspaceId, list)
	}

	for (const [workspaceId, contacts] of byWorkspace) {
		const ws: StaleClaimWorkspaceResult = {
			workspaceId,
			examined_count: contacts.length,
			swept_count: 0,
			swept_contact_ids: [],
			confirmed_count: 0,
			fresh_count: 0,
			lost_count: 0,
		}
		for (const contact of contacts) {
			if (contact.webhookAfterClaim) {
				ws.confirmed_count++
				continue
			}
			if (now.getTime() - contact.claimedAt.getTime() < thresholdMs) {
				ws.fresh_count++
				continue
			}
			try {
				if (!(await deps.store.sweep(contact, actorId, now, deps.thresholdMinutes))) {
					ws.lost_count++
					continue
				}
			} catch (err) {
				logger.error('voice stale-claim sweep failed for a contact', {
					workspaceId,
					contactId: contact.contactId,
					error: err instanceof Error ? err.message : String(err),
				})
				continue
			}
			ws.swept_count++
			ws.swept_contact_ids.push(contact.contactId)
			// The contact is already swept; a failed alert must not undo or hide that.
			try {
				await deps.deadLetter(
					{
						workspaceId,
						contactId: contact.contactId,
						actorId,
						dialAttemptN: contact.dialAttemptN,
					},
					SWEEP_REASON,
				)
			} catch (err) {
				logger.error('voice stale-claim sweep dead letter failed', {
					workspaceId,
					contactId: contact.contactId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		// One summary event per workspace per run, so a reviewer can grep swept_count.
		// Workspaces with nothing in voice_dialing are not visited and write nothing.
		await deps.store.recordEvent({
			workspaceId,
			actorId,
			action: SWEEP_EVENT_SOURCE,
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				source: SWEEP_EVENT_SOURCE,
				sweep_at: result.sweep_at,
				threshold_minutes: deps.thresholdMinutes,
				examined_count: ws.examined_count,
				swept_count: ws.swept_count,
				confirmed_count: ws.confirmed_count,
				fresh_count: ws.fresh_count,
				lost_count: ws.lost_count,
				swept_contact_ids: ws.swept_contact_ids.slice(0, MAX_SUMMARY_IDS),
			},
		})
		result.examined_count += ws.examined_count
		result.swept_count += ws.swept_count
		result.workspaces.push(ws)
	}
	return result
}
