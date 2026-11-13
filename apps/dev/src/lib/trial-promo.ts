import type { Database } from '@maskin/db'
import { trialPromoCodes, workspaces } from '@maskin/db/schema'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { capturePosthogEvent } from './analytics/posthog'
import { evictBillingUsage } from './billing-usage-cache'
import { createWindowLimiter } from './fixed-window-limiter'
import { logger } from './logger'
import { DAY_SECONDS, TrialCardError } from './trial-card'

// Promo codes at the start-trial page (bet "A card to start a 7-day trial", task "Promo code on the
// start-trial page"). A valid code starts the trial with no card, and it lasts the code's own
// trial_days (14 for new codes; a card trial is 7). Codes live in our own table
// (trial_promo_codes), not in Stripe: Stripe counts a promotion code as used only when it is applied
// to a checkout or subscription, and a trial with no card has neither, so Stripe could neither say
// "this code skips the card" nor count the use for us.
//
// The page asks `promoCodeTrialDays` when the person presses Apply. That only looks; nothing is used up.
// The code is used up by `startTrialWithPromo`, which re-checks it in the same transaction that
// starts the trial, so the page is never trusted and two people cannot take the last use.

/** A code is upper case letters, digits, underscore and hyphen, 4 to 64 long. Anything else cannot exist. */
const CODE_SHAPE = /^[A-Z0-9_-]{4,64}$/

/** What the person typed, tidied to how codes are stored; null when it cannot be a code. */
export function normalizePromoCode(raw: string): string | null {
	const code = raw.trim().toUpperCase()
	return CODE_SHAPE.test(code) ? code : null
}

/** The code is wrong, expired, switched off or used up. Deliberately one answer for all four. */
export class TrialPromoCodeInvalidError extends Error {
	constructor() {
		super('This promo code is not valid, or it has been used up.')
		this.name = 'TrialPromoCodeInvalidError'
	}
}

// Brake on guessing: 10 tries a minute per person and 30 a minute per address (several people
// behind one office address share it). In-process like the other flood guards here; the deployment
// is one instance. Codes should be long and random, so this is a brake, not the only protection.
const actorLimiter = createWindowLimiter({ limit: 10, windowMs: 60_000 })
const ipLimiter = createWindowLimiter({ limit: 30, windowMs: 60_000 })

/** Counts one try. `allowed: false` means answer 429 with Retry-After. */
export function hitPromoRateLimit(
	actorId: string,
	ip: string,
): { allowed: boolean; retryAfterMs: number } {
	const byActor = actorLimiter.hit(actorId)
	const byIp = ipLimiter.hit(ip)
	return {
		allowed: byActor.allowed && byIp.allowed,
		retryAfterMs: Math.max(byActor.retryAfterMs, byIp.retryAfterMs),
	}
}

/** Exposed so tests do not poison each other through shared limiter state. */
export function resetPromoRateLimitForTests() {
	actorLimiter.reset()
	ipLimiter.reset()
}

/** The conditions under which a code can still be used. Shared by the look and the use. */
function usable(now: Date) {
	return and(
		eq(trialPromoCodes.active, true),
		lt(trialPromoCodes.redemptions, trialPromoCodes.maxRedemptions),
		or(isNull(trialPromoCodes.expiresAt), gt(trialPromoCodes.expiresAt, now)),
	)
}

/**
 * The trial length in days if the code could be used right now, otherwise null. Looks only;
 * nothing is used up.
 */
export async function promoCodeTrialDays(
	db: Database,
	raw: string,
	now = new Date(),
): Promise<number | null> {
	const code = normalizePromoCode(raw)
	if (!code) return null
	const [row] = await db
		.select({ trialDays: trialPromoCodes.trialDays })
		.from(trialPromoCodes)
		.where(and(eq(trialPromoCodes.code, code), usable(now)))
		.limit(1)
	return row?.trialDays ?? null
}

export type RecordPromoTrialOutcome =
	| { outcome: 'started'; periodEnd: number }
	| { outcome: 'already_started'; periodEnd: number | null }
	| { outcome: 'not_waiting' }
	| { outcome: 'invalid_code' }

/**
 * The database half of starting a trial with a code. In one transaction: lock the workspace, check
 * it is waiting for its card, use up one redemption with a single conditional UPDATE (it only
 * matches while the code is active, unexpired and under its limit, so the last use goes to exactly
 * one caller), and start the code's trial_days. If any step fails nothing is used up. Stores the code's id on
 * the workspace, never the code text, and no card or fingerprint.
 */
export async function recordPromoTrialStart(params: {
	db: Database
	workspaceId: string
	code: string
	nowSec: number
}): Promise<RecordPromoTrialOutcome> {
	const { db, workspaceId, nowSec } = params
	const code = normalizePromoCode(params.code)
	if (!code) return { outcome: 'invalid_code' }
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!row) throw new TrialCardError(404, 'NOT_FOUND', 'Workspace not found')
		const settings = (row.settings ?? {}) as Record<string, unknown>
		const billing = (settings.billing ?? {}) as Record<string, unknown>

		if (billing.trial_state === 'started') {
			return {
				outcome: 'already_started',
				periodEnd: typeof billing.period_end === 'number' ? billing.period_end : null,
			} as const
		}
		if (billing.trial_state !== 'awaiting_card') return { outcome: 'not_waiting' } as const

		const [redeemed] = await tx
			.update(trialPromoCodes)
			.set({ redemptions: sql`${trialPromoCodes.redemptions} + 1` })
			.where(and(eq(trialPromoCodes.code, code), usable(new Date(nowSec * 1000))))
			.returning({ id: trialPromoCodes.id, trialDays: trialPromoCodes.trialDays })
		if (!redeemed) return { outcome: 'invalid_code' } as const

		const periodEnd = nowSec + redeemed.trialDays * DAY_SECONDS
		await tx
			.update(workspaces)
			.set({
				settings: {
					...settings,
					billing: {
						...billing,
						plan: 'trial',
						trial_state: 'started',
						trial_promo_code_id: redeemed.id,
						period_start: nowSec,
						period_end: periodEnd,
					},
				},
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))
		return { outcome: 'started', periodEnd } as const
	})
}

/**
 * Starts the trial with a promo code and no card, for the code's own length. Sends trial_started with promo true and no
 * card; the event carries ids, booleans and a category only, never the code.
 */
export async function startTrialWithPromo(params: {
	db: Database
	workspaceId: string
	actorId: string
	code: string
	nowSec?: number
	/** Runs after the trial has started, e.g. the Chief of Staff welcome. Never throws into the request. */
	onStarted?: () => Promise<void>
}): Promise<{ trialEndsAt: number | null }> {
	const { db, workspaceId, actorId } = params
	const result = await recordPromoTrialStart({
		db,
		workspaceId,
		code: params.code,
		nowSec: params.nowSec ?? Math.floor(Date.now() / 1000),
	})
	if (result.outcome === 'invalid_code') throw new TrialPromoCodeInvalidError()
	if (result.outcome === 'not_waiting') {
		throw new TrialCardError(409, 'CONFLICT', 'This workspace is not waiting for a card')
	}
	if (result.outcome === 'already_started') return { trialEndsAt: result.periodEnd }

	evictBillingUsage(workspaceId)
	void capturePosthogEvent('trial_started', actorId, {
		workspace_id: workspaceId,
		plan: 'trial',
		card_present: false,
		promo: true,
	})
	if (params.onStarted) {
		await params
			.onStarted()
			.catch((err) =>
				logger.error('Trial started, but the welcome could not start', { workspaceId, err }),
			)
	}
	return { trialEndsAt: result.periodEnd }
}
