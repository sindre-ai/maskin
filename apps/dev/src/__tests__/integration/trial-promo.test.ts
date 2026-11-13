import { trialCards, trialPromoCodes, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn() }))

import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { DAY_SECONDS, TRIAL_LENGTH_SECONDS, TrialCardError } from '../../lib/trial-card'
import {
	TrialPromoCodeInvalidError,
	normalizePromoCode,
	promoCodeTrialDays,
	recordPromoTrialStart,
	startTrialWithPromo,
} from '../../lib/trial-promo'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

// Promo codes at the start-trial page: a valid code starts the trial with no card for the code's
// own trial_days (14 for a new code, 7 for a card), the server re-checks it when the trial starts, and the last use goes to exactly one caller.

const NOW = 1_800_000_000
let seq = 0
const newCode = () => `PROMO-${Date.now().toString(36).toUpperCase()}-${seq++}`

async function insertCode(
	overrides: Partial<{
		code: string
		maxRedemptions: number
		redemptions: number
		trialDays: number
		expiresAt: Date | null
		active: boolean
	}> = {},
) {
	const code = overrides.code ?? newCode()
	const [row] = await db
		.insert(trialPromoCodes)
		.values({ code, maxRedemptions: 5, ...overrides })
		.returning()
	if (!row) throw new Error('code not inserted')
	return row
}

async function waitingWorkspace() {
	const actor = await insertActor(db)
	const ws = await insertWorkspace(db, actor.id, {
		settings: { billing: { plan: 'trial', trial_state: 'awaiting_card' } },
	})
	return { actor, ws }
}

async function billingOf(workspaceId: string) {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	return (row?.settings as { billing?: Record<string, unknown> }).billing ?? {}
}

async function redemptionsOf(id: string) {
	const [row] = await db.select().from(trialPromoCodes).where(eq(trialPromoCodes.id, id))
	return row?.redemptions
}

beforeEach(() => {
	vi.mocked(capturePosthogEvent).mockClear()
})

describe('normalizePromoCode', () => {
	it('tidies what the person typed and refuses what cannot be a code', () => {
		expect(normalizePromoCode('  friends-2026 ')).toBe('FRIENDS-2026')
		expect(normalizePromoCode('abc')).toBeNull()
		expect(normalizePromoCode("x'; drop table")).toBeNull()
		expect(normalizePromoCode('a'.repeat(65))).toBeNull()
	})
})

describe('promoCodeTrialDays', () => {
	it('gives 14 days for a new code, in any letter case, and does not use it up', async () => {
		const row = await insertCode()
		expect(await promoCodeTrialDays(db, row.code.toLowerCase())).toBe(14)
		expect(await redemptionsOf(row.id)).toBe(0)
	})

	it("gives the code's own length", async () => {
		const row = await insertCode({ trialDays: 7 })
		expect(await promoCodeTrialDays(db, row.code)).toBe(7)
	})

	it('refuses an unknown code', async () => {
		expect(await promoCodeTrialDays(db, 'NOPE-NOT-A-CODE')).toBeNull()
	})

	it('refuses an expired code', async () => {
		const row = await insertCode({ expiresAt: new Date(Date.now() - 60_000) })
		expect(await promoCodeTrialDays(db, row.code)).toBeNull()
	})

	it('refuses a code that is switched off', async () => {
		const row = await insertCode({ active: false })
		expect(await promoCodeTrialDays(db, row.code)).toBeNull()
	})

	it('refuses a code that is used up', async () => {
		const row = await insertCode({ maxRedemptions: 2, redemptions: 2 })
		expect(await promoCodeTrialDays(db, row.code)).toBeNull()
	})
})

describe('recordPromoTrialStart', () => {
	it('starts a 14 day trial with no card and uses up one redemption', async () => {
		const row = await insertCode()
		const { ws } = await waitingWorkspace()

		const result = await recordPromoTrialStart({
			db,
			workspaceId: ws.id,
			code: row.code,
			nowSec: NOW,
		})

		expect(result).toEqual({ outcome: 'started', periodEnd: NOW + 14 * DAY_SECONDS })
		const billing = await billingOf(ws.id)
		expect(billing).toMatchObject({
			plan: 'trial',
			trial_state: 'started',
			trial_promo_code_id: row.id,
			period_start: NOW,
			period_end: NOW + 14 * DAY_SECONDS,
		})
		// No card: no wallet, no Stripe customer, nothing in the fingerprint table.
		expect(billing).not.toHaveProperty('trial_wallet')
		expect(billing).not.toHaveProperty('stripe_customer_id')
		expect(JSON.stringify(billing)).not.toContain(row.code)
		expect(
			await db.select().from(trialCards).where(eq(trialCards.workspaceId, ws.id)),
		).toHaveLength(0)
		expect(await redemptionsOf(row.id)).toBe(1)
	})

	it('keeps a 7 day trial for a code that carries 7 days, and a card trial is still 7', async () => {
		const row = await insertCode({ trialDays: 7 })
		const { ws } = await waitingWorkspace()

		expect(
			await recordPromoTrialStart({ db, workspaceId: ws.id, code: row.code, nowSec: NOW }),
		).toEqual({ outcome: 'started', periodEnd: NOW + TRIAL_LENGTH_SECONDS })
		expect(TRIAL_LENGTH_SECONDS).toBe(7 * DAY_SECONDS)
	})

	it('refuses a wrong code and leaves the workspace waiting', async () => {
		const row = await insertCode()
		const { ws } = await waitingWorkspace()

		const result = await recordPromoTrialStart({
			db,
			workspaceId: ws.id,
			code: 'WRONG-CODE-1',
			nowSec: NOW,
		})

		expect(result).toEqual({ outcome: 'invalid_code' })
		expect((await billingOf(ws.id)).trial_state).toBe('awaiting_card')
		expect(await redemptionsOf(row.id)).toBe(0)
	})

	it('refuses an expired code even if the page checked it a minute earlier', async () => {
		const row = await insertCode({ expiresAt: new Date((NOW - 1) * 1000) })
		const { ws } = await waitingWorkspace()
		expect(
			await recordPromoTrialStart({ db, workspaceId: ws.id, code: row.code, nowSec: NOW }),
		).toEqual({ outcome: 'invalid_code' })
		expect((await billingOf(ws.id)).trial_state).toBe('awaiting_card')
	})

	it('refuses a second person once the code is used up', async () => {
		const row = await insertCode({ maxRedemptions: 1 })
		const first = await waitingWorkspace()
		const second = await waitingWorkspace()

		expect(
			(await recordPromoTrialStart({ db, workspaceId: first.ws.id, code: row.code, nowSec: NOW }))
				.outcome,
		).toBe('started')
		expect(
			await recordPromoTrialStart({ db, workspaceId: second.ws.id, code: row.code, nowSec: NOW }),
		).toEqual({ outcome: 'invalid_code' })

		expect((await billingOf(second.ws.id)).trial_state).toBe('awaiting_card')
		expect(await redemptionsOf(row.id)).toBe(1)
	})

	it('gives the last use to exactly one of several racing workspaces', async () => {
		const row = await insertCode({ maxRedemptions: 1 })
		const workspaceIds = await Promise.all(
			[1, 2, 3, 4].map(async () => (await waitingWorkspace()).ws.id),
		)

		const outcomes = (
			await Promise.all(
				workspaceIds.map((workspaceId) =>
					recordPromoTrialStart({ db, workspaceId, code: row.code, nowSec: NOW }),
				),
			)
		).map((r) => r.outcome)

		expect(outcomes.filter((o) => o === 'started')).toHaveLength(1)
		expect(outcomes.filter((o) => o === 'invalid_code')).toHaveLength(3)
		expect(await redemptionsOf(row.id)).toBe(1)
	})

	it('does not use up a redemption for a workspace that is not waiting for a card', async () => {
		const row = await insertCode()
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)

		expect(
			await recordPromoTrialStart({ db, workspaceId: ws.id, code: row.code, nowSec: NOW }),
		).toEqual({ outcome: 'not_waiting' })
		expect(await redemptionsOf(row.id)).toBe(0)
	})

	it('answers a second call from the same workspace without using up another redemption', async () => {
		const row = await insertCode()
		const { ws } = await waitingWorkspace()
		const args = { db, workspaceId: ws.id, code: row.code } as const

		await recordPromoTrialStart({ ...args, nowSec: NOW })
		expect(await recordPromoTrialStart({ ...args, nowSec: NOW + 500 })).toEqual({
			outcome: 'already_started',
			periodEnd: NOW + 14 * DAY_SECONDS,
		})
		expect(await redemptionsOf(row.id)).toBe(1)
	})
})

describe('startTrialWithPromo', () => {
	it('starts the trial, runs the follow-up once, and sends an event without the code', async () => {
		const row = await insertCode()
		const { actor, ws } = await waitingWorkspace()
		const onStarted = vi.fn().mockResolvedValue(undefined)

		const result = await startTrialWithPromo({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			code: row.code,
			nowSec: NOW,
			onStarted,
		})

		expect(result).toEqual({ trialEndsAt: NOW + 14 * DAY_SECONDS })
		expect(onStarted).toHaveBeenCalledTimes(1)
		expect(capturePosthogEvent).toHaveBeenCalledWith('trial_started', actor.id, {
			workspace_id: ws.id,
			plan: 'trial',
			card_present: false,
			promo: true,
		})
		expect(JSON.stringify(vi.mocked(capturePosthogEvent).mock.calls)).not.toContain(row.code)
	})

	it('throws the invalid code error, sends no event and starts nothing', async () => {
		const { actor, ws } = await waitingWorkspace()
		const onStarted = vi.fn()

		await expect(
			startTrialWithPromo({
				db,
				workspaceId: ws.id,
				actorId: actor.id,
				code: 'WRONG-CODE-2',
				onStarted,
			}),
		).rejects.toBeInstanceOf(TrialPromoCodeInvalidError)

		expect(onStarted).not.toHaveBeenCalled()
		expect(capturePosthogEvent).not.toHaveBeenCalled()
		expect((await billingOf(ws.id)).trial_state).toBe('awaiting_card')
	})

	it('refuses a workspace that is not waiting for a card', async () => {
		const row = await insertCode()
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)

		await expect(
			startTrialWithPromo({ db, workspaceId: ws.id, actorId: actor.id, code: row.code }),
		).rejects.toBeInstanceOf(TrialCardError)
		expect(await redemptionsOf(row.id)).toBe(0)
	})
})
