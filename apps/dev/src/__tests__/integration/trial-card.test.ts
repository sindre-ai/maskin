import { trialCards, workspaceMembers, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
	TRIAL_LENGTH_SECONDS,
	TrialCardAlreadyUsedError,
	TrialCardError,
	createTrialSetup,
	recordTrialStart,
	startTrial,
} from '../../lib/trial-card'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

// Card step at sign-up (bet "A card to start a 7-day trial", task T2): a plain card that already
// started a trial cannot start another; a wallet card is let through and never stored.

const NOW = 1_800_000_000
let seq = 0
const fingerprint = () => `fp_test_${Date.now()}_${seq++}`

async function waitingWorkspace(billing: Record<string, unknown> = {}) {
	const actor = await insertActor(db)
	const ws = await insertWorkspace(db, actor.id, {
		settings: { billing: { plan: 'trial', trial_state: 'awaiting_card', ...billing } },
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

describe('recordTrialStart', () => {
	it('starts a 7 day trial and remembers a plain card', async () => {
		const { ws } = await waitingWorkspace()
		const fp = fingerprint()

		const result = await recordTrialStart({
			db,
			workspaceId: ws.id,
			fingerprint: fp,
			wallet: 'none',
			customerId: 'cus_1',
			nowSec: NOW,
		})

		expect(result).toEqual({ outcome: 'started', periodEnd: NOW + TRIAL_LENGTH_SECONDS })
		expect(await billingOf(ws.id)).toMatchObject({
			plan: 'trial',
			trial_state: 'started',
			trial_wallet: 'none',
			stripe_customer_id: 'cus_1',
			period_start: NOW,
			period_end: NOW + 7 * 24 * 60 * 60,
		})
		const stored = await db.select().from(trialCards).where(eq(trialCards.fingerprint, fp))
		expect(stored).toHaveLength(1)
		expect(stored[0]?.workspaceId).toBe(ws.id)
	})

	it('refuses the same plain card on a second workspace and leaves that workspace waiting', async () => {
		const first = await waitingWorkspace()
		const second = await waitingWorkspace()
		const fp = fingerprint()
		const args = { db, fingerprint: fp, wallet: 'none', customerId: 'cus_x', nowSec: NOW } as const

		expect((await recordTrialStart({ ...args, workspaceId: first.ws.id })).outcome).toBe('started')
		expect(await recordTrialStart({ ...args, workspaceId: second.ws.id })).toEqual({
			outcome: 'duplicate',
		})

		expect((await billingOf(second.ws.id)).trial_state).toBe('awaiting_card')
		expect(await db.select().from(trialCards).where(eq(trialCards.fingerprint, fp))).toHaveLength(1)
	})

	it('lets exactly one of two racing workspaces win the same card', async () => {
		const a = await waitingWorkspace()
		const b = await waitingWorkspace()
		const fp = fingerprint()
		const run = (workspaceId: string) =>
			recordTrialStart({
				db,
				workspaceId,
				fingerprint: fp,
				wallet: 'none',
				customerId: 'cus_race',
				nowSec: NOW,
			})

		const outcomes = (await Promise.all([run(a.ws.id), run(b.ws.id)])).map((r) => r.outcome).sort()
		expect(outcomes).toEqual(['duplicate', 'started'])
	})

	it('treats the same workspace asking again as already started, not a second trial', async () => {
		const { ws } = await waitingWorkspace()
		const args = {
			db,
			workspaceId: ws.id,
			fingerprint: fingerprint(),
			wallet: 'none',
			customerId: 'cus_again',
			nowSec: NOW,
		} as const

		await recordTrialStart(args)
		expect(await recordTrialStart({ ...args, nowSec: NOW + 500 })).toEqual({
			outcome: 'already_started',
			periodEnd: NOW + TRIAL_LENGTH_SECONDS,
		})
	})

	it('lets a wallet card through twice and never stores it', async () => {
		const first = await waitingWorkspace()
		const second = await waitingWorkspace()
		const fp = fingerprint()

		for (const [ws, wallet] of [
			[first.ws, 'apple_pay'],
			[second.ws, 'google_pay'],
		] as const) {
			const result = await recordTrialStart({
				db,
				workspaceId: ws.id,
				fingerprint: fp,
				wallet,
				customerId: 'cus_wallet',
				nowSec: NOW,
			})
			expect(result.outcome).toBe('started')
			expect((await billingOf(ws.id)).trial_wallet).toBe(wallet)
		}
		expect(await db.select().from(trialCards).where(eq(trialCards.fingerprint, fp))).toHaveLength(0)
	})

	it('does nothing for a workspace that never went through the card step', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)
		const result = await recordTrialStart({
			db,
			workspaceId: ws.id,
			fingerprint: fingerprint(),
			wallet: 'none',
			customerId: 'cus_none',
			nowSec: NOW,
		})
		expect(result).toEqual({ outcome: 'not_waiting' })
	})

	it('keeps a card used after its workspace is deleted', async () => {
		const gone = await waitingWorkspace()
		const next = await waitingWorkspace()
		const fp = fingerprint()
		const args = {
			db,
			fingerprint: fp,
			wallet: 'none',
			customerId: 'cus_del',
			nowSec: NOW,
		} as const
		await recordTrialStart({ ...args, workspaceId: gone.ws.id })

		await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, gone.ws.id))
		await db.delete(workspaces).where(eq(workspaces.id, gone.ws.id))

		const [kept] = await db.select().from(trialCards).where(eq(trialCards.fingerprint, fp))
		expect(kept?.workspaceId).toBeNull()
		expect((await recordTrialStart({ ...args, workspaceId: next.ws.id })).outcome).toBe('duplicate')
	})
})

function fakeStripe(overrides: { setupIntent?: Partial<Stripe.SetupIntent>; card?: object } = {}) {
	const paymentMethod = {
		id: 'pm_1',
		type: 'card',
		card: { fingerprint: fingerprint(), wallet: null, ...overrides.card },
	}
	const stripe = {
		customers: {
			create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
			update: vi.fn().mockResolvedValue({}),
		},
		setupIntents: {
			create: vi.fn().mockResolvedValue({ id: 'seti_1', client_secret: 'seti_1_secret' }),
			retrieve: vi.fn(),
		},
		paymentMethods: { detach: vi.fn().mockResolvedValue({}) },
	}
	return { stripe: stripe as unknown as Stripe, mocks: stripe, paymentMethod }
}

function succeeded(
	workspaceId: string,
	paymentMethod: object,
	extra: Partial<Stripe.SetupIntent> = {},
) {
	return {
		id: 'seti_1',
		status: 'succeeded',
		customer: 'cus_new',
		metadata: { workspace_id: workspaceId, kind: 'trial_card' },
		payment_method: paymentMethod,
		...extra,
	} as unknown as Stripe.SetupIntent
}

describe('createTrialSetup', () => {
	it('makes one Stripe customer, remembers it, and returns the card form secret', async () => {
		const { ws } = await waitingWorkspace()
		const { stripe, mocks } = fakeStripe()

		const result = await createTrialSetup({ db, stripe, workspaceId: ws.id })

		expect(result).toEqual({ clientSecret: 'seti_1_secret' })
		expect(mocks.customers.create).toHaveBeenCalledTimes(1)
		expect(mocks.setupIntents.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: 'cus_new', usage: 'off_session' }),
		)
		expect((await billingOf(ws.id)).stripe_customer_id).toBe('cus_new')

		await createTrialSetup({ db, stripe, workspaceId: ws.id })
		expect(mocks.customers.create).toHaveBeenCalledTimes(1)
	})

	it('refuses a workspace that is not waiting for a card', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)
		const { stripe } = fakeStripe()
		await expect(createTrialSetup({ db, stripe, workspaceId: ws.id })).rejects.toMatchObject({
			status: 409,
		})
	})
})

describe('startTrial', () => {
	it('starts the trial from a finished setup and runs the follow-up once', async () => {
		const { ws, actor } = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const { stripe, mocks, paymentMethod } = fakeStripe()
		mocks.setupIntents.retrieve.mockResolvedValue(succeeded(ws.id, paymentMethod))
		const onStarted = vi.fn().mockResolvedValue(undefined)

		const result = await startTrial({
			db,
			stripe,
			workspaceId: ws.id,
			actorId: actor.id,
			setupIntentId: 'seti_1',
			nowSec: NOW,
			onStarted,
		})

		expect(result).toEqual({ trialEndsAt: NOW + TRIAL_LENGTH_SECONDS })
		expect((await billingOf(ws.id)).trial_state).toBe('started')
		expect(mocks.customers.update).toHaveBeenCalledWith('cus_new', {
			invoice_settings: { default_payment_method: 'pm_1' },
		})
		expect(onStarted).toHaveBeenCalledTimes(1)
	})

	it('refuses a used card, takes it off the customer, and leaves the workspace waiting', async () => {
		const first = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const second = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const fp = fingerprint()
		const one = fakeStripe({ card: { fingerprint: fp } })
		one.mocks.setupIntents.retrieve.mockResolvedValue(succeeded(first.ws.id, one.paymentMethod))
		await startTrial({
			db,
			stripe: one.stripe,
			workspaceId: first.ws.id,
			actorId: first.actor.id,
			setupIntentId: 'seti_1',
		})

		const two = fakeStripe({ card: { fingerprint: fp } })
		two.mocks.setupIntents.retrieve.mockResolvedValue(succeeded(second.ws.id, two.paymentMethod))
		const onStarted = vi.fn()
		await expect(
			startTrial({
				db,
				stripe: two.stripe,
				workspaceId: second.ws.id,
				actorId: second.actor.id,
				setupIntentId: 'seti_1',
				onStarted,
			}),
		).rejects.toBeInstanceOf(TrialCardAlreadyUsedError)

		expect(two.mocks.paymentMethods.detach).toHaveBeenCalledWith('pm_1')
		expect(two.mocks.customers.update).not.toHaveBeenCalled()
		expect(onStarted).not.toHaveBeenCalled()
		expect((await billingOf(second.ws.id)).trial_state).toBe('awaiting_card')
	})

	it('records the wallet type for an Apple Pay card and lets it through', async () => {
		const { ws, actor } = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const { stripe, mocks, paymentMethod } = fakeStripe({
			card: { wallet: { type: 'apple_pay' } },
		})
		mocks.setupIntents.retrieve.mockResolvedValue(succeeded(ws.id, paymentMethod))

		await startTrial({
			db,
			stripe,
			workspaceId: ws.id,
			actorId: actor.id,
			setupIntentId: 'seti_1',
		})

		expect((await billingOf(ws.id)).trial_wallet).toBe('apple_pay')
	})

	it("refuses another workspace's card setup", async () => {
		const mine = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const other = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const { stripe, mocks, paymentMethod } = fakeStripe()
		mocks.setupIntents.retrieve.mockResolvedValue(succeeded(other.ws.id, paymentMethod))

		const err = await startTrial({
			db,
			stripe,
			workspaceId: mine.ws.id,
			actorId: mine.actor.id,
			setupIntentId: 'seti_1',
		}).catch((e) => e)

		expect(err).toBeInstanceOf(TrialCardError)
		expect(err.status).toBe(400)
		expect((await billingOf(mine.ws.id)).trial_state).toBe('awaiting_card')
	})

	it('refuses a setup that did not finish', async () => {
		const { ws, actor } = await waitingWorkspace({ stripe_customer_id: 'cus_new' })
		const { stripe, mocks, paymentMethod } = fakeStripe()
		mocks.setupIntents.retrieve.mockResolvedValue(
			succeeded(ws.id, paymentMethod, { status: 'requires_payment_method' }),
		)

		await expect(
			startTrial({ db, stripe, workspaceId: ws.id, actorId: actor.id, setupIntentId: 'seti_1' }),
		).rejects.toMatchObject({ status: 400 })
	})

	it('answers a second call after the trial started without asking Stripe again', async () => {
		const { ws, actor } = await waitingWorkspace({
			stripe_customer_id: 'cus_new',
			trial_state: 'started',
			period_end: NOW + 100,
		})
		const { stripe, mocks } = fakeStripe()

		const result = await startTrial({
			db,
			stripe,
			workspaceId: ws.id,
			actorId: actor.id,
			setupIntentId: 'seti_1',
		})

		expect(result).toEqual({ trialEndsAt: NOW + 100 })
		expect(mocks.setupIntents.retrieve).not.toHaveBeenCalled()
	})
})
