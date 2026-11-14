import type { Database } from '@maskin/db'
import { trialCards, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { capturePosthogEvent } from './analytics/posthog'
import { evictBillingUsage } from './billing-usage-cache'
import { isEnterpriseActor } from './enterprise'
import { FLAGS, isSignupFlagEnabled } from './feature-flags'
import { logger } from './logger'
import { ownedWorkspacePlans } from './workspace-capacity'

// The card step at sign-up (bet "A card to start a 7-day trial", task T2). A workspace that signed
// up through the card step waits (`billing.trial_state = 'awaiting_card'`, and no session starts)
// until a card is saved with Stripe, without a charge. A plain card that already started a trial
// somewhere else is refused; a wallet card (Apple Pay, Google Pay) is let through, because its
// fingerprint comes from a device number and cannot recognise the card.

export const DAY_SECONDS = 24 * 60 * 60

/** The trial a card starts. A promo code can carry its own length (trial_promo_codes.trial_days). */
export const TRIAL_LENGTH_SECONDS = 7 * DAY_SECONDS

export type TrialWallet = 'apple_pay' | 'google_pay' | 'other' | 'none'

/** A failure the route turns into an HTTP answer. */
export class TrialCardError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 500,
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR',
		message: string,
	) {
		super(message)
		this.name = 'TrialCardError'
	}
}

/** The card already started a free trial. 409 with code TRIAL_CARD_ALREADY_USED. */
export class TrialCardAlreadyUsedError extends Error {
	constructor() {
		super('This card has already started a free trial.')
		this.name = 'TrialCardAlreadyUsedError'
	}
}

/**
 * Whether a workspace made through POST /api/workspaces must wait for a card, like one made at
 * sign-up. Without this, a person who skipped the card step (or deleted that workspace) could make
 * another workspace and get a trial with no card. A person who already owns a paid workspace has a
 * card with Stripe, so they are let through; so are agents and enterprise owners.
 */
export async function newWorkspaceNeedsCard(
	db: Database,
	actorId: string,
	actorType: string,
): Promise<boolean> {
	if (actorType !== 'human' || !isSignupFlagEnabled(FLAGS.TRIAL_CARD_PERCENT)) return false
	if (isEnterpriseActor(actorId)) return false
	const plans = await ownedWorkspacePlans(db, actorId)
	return plans.every((plan) => plan === 'trial')
}

/** How the card was entered: a wallet type, or none for plain entry. */
export function trialWalletOf(card: Stripe.PaymentMethod.Card): TrialWallet {
	const type = card.wallet?.type
	if (!type) return 'none'
	if (type === 'apple_pay' || type === 'google_pay') return type
	return 'other'
}

async function readBilling(db: Database, workspaceId: string) {
	const [workspace] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) throw new TrialCardError(404, 'NOT_FOUND', 'Workspace not found')
	const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	return parsed.success ? parsed.data.billing : undefined
}

/**
 * Starts a Stripe card setup (no charge) for a workspace that is waiting for its card. Creates the
 * Stripe customer once and remembers it on the workspace, so the later plan checkout reuses it.
 */
export async function createTrialSetup(params: {
	db: Database
	stripe: Stripe
	workspaceId: string
}): Promise<{ clientSecret: string }> {
	const { db, stripe, workspaceId } = params
	const billing = await readBilling(db, workspaceId)
	if (billing?.trial_state === 'started') {
		throw new TrialCardError(409, 'CONFLICT', 'Your trial has already started')
	}
	if (billing?.trial_state !== 'awaiting_card') {
		throw new TrialCardError(409, 'CONFLICT', 'This workspace does not need a card to start')
	}

	let customerId = billing.stripe_customer_id ?? null
	if (!customerId) {
		// One customer per workspace even when two setups race: Stripe returns the first result
		// for a repeated idempotency key.
		const customer = await stripe.customers.create(
			{ metadata: { workspace_id: workspaceId } },
			{ idempotencyKey: `trial-customer-${workspaceId}` },
		)
		customerId = customer.id
		await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ settings: workspaces.settings })
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.for('update')
				.limit(1)
			const settings = (row?.settings ?? {}) as Record<string, unknown>
			const current = (settings.billing ?? {}) as Record<string, unknown>
			if (current.stripe_customer_id) return
			await tx
				.update(workspaces)
				.set({
					settings: { ...settings, billing: { ...current, stripe_customer_id: customerId } },
					updatedAt: new Date(),
				})
				.where(eq(workspaces.id, workspaceId))
		})
	}

	const setupIntent = await stripe.setupIntents.create({
		customer: customerId,
		usage: 'off_session',
		payment_method_types: ['card'],
		metadata: { workspace_id: workspaceId, kind: 'trial_card' },
	})
	if (!setupIntent.client_secret) {
		throw new TrialCardError(500, 'INTERNAL_ERROR', 'Stripe returned no card setup')
	}
	return { clientSecret: setupIntent.client_secret }
}

export type RecordTrialStartOutcome =
	| { outcome: 'started'; periodEnd: number }
	| { outcome: 'already_started'; periodEnd: number | null }
	| { outcome: 'duplicate' }
	| { outcome: 'not_waiting' }

/**
 * The database half of starting a trial: refuses a plain card that already started one (the unique
 * index decides, so two racing requests cannot both win), and moves the workspace from
 * awaiting_card to started with a 7 day window. Wallet cards are not stored and not matched.
 */
export async function recordTrialStart(params: {
	db: Database
	workspaceId: string
	fingerprint: string | null
	wallet: TrialWallet
	customerId: string
	nowSec: number
}): Promise<RecordTrialStartOutcome> {
	const { db, workspaceId, fingerprint, wallet, customerId, nowSec } = params
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

		if (wallet === 'none') {
			if (fingerprint) {
				const inserted = await tx
					.insert(trialCards)
					.values({ fingerprint, workspaceId })
					.onConflictDoNothing()
					.returning({ id: trialCards.id })
				if (inserted.length === 0) {
					const [existing] = await tx
						.select({ workspaceId: trialCards.workspaceId })
						.from(trialCards)
						.where(eq(trialCards.fingerprint, fingerprint))
						.limit(1)
					// The same workspace trying its own card again is not a second trial.
					if (existing?.workspaceId !== workspaceId) return { outcome: 'duplicate' } as const
				}
			} else {
				logger.warn('Trial card has no fingerprint, so it cannot be matched', { workspaceId })
			}
		}

		const periodEnd = nowSec + TRIAL_LENGTH_SECONDS
		await tx
			.update(workspaces)
			.set({
				settings: {
					...settings,
					billing: {
						...billing,
						plan: 'trial',
						trial_state: 'started',
						trial_wallet: wallet,
						stripe_customer_id: customerId,
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
 * Starts the 7 day trial from a finished Stripe card setup. Checks the setup belongs to this
 * workspace, reads the card's fingerprint and wallet from Stripe (never from the client), then
 * hands the decision to `recordTrialStart`. Sends trial_started or trial_card_rejected_duplicate
 * from here; the events carry only the plan, a boolean, a category and ids.
 */
export async function startTrial(params: {
	db: Database
	stripe: Stripe
	workspaceId: string
	actorId: string
	setupIntentId: string
	nowSec?: number
	/** Runs after the trial has started, e.g. the Chief of Staff welcome. Never throws into the request. */
	onStarted?: () => Promise<void>
}): Promise<{ trialEndsAt: number | null }> {
	const { db, stripe, workspaceId, actorId, setupIntentId } = params
	const billing = await readBilling(db, workspaceId)
	if (billing?.trial_state === 'started') {
		return { trialEndsAt: billing.period_end ?? null }
	}
	if (billing?.trial_state !== 'awaiting_card' || !billing.stripe_customer_id) {
		throw new TrialCardError(409, 'CONFLICT', 'This workspace is not waiting for a card')
	}

	const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
		expand: ['payment_method'],
	})
	const customerOnIntent =
		typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id
	if (
		setupIntent.metadata?.workspace_id !== workspaceId ||
		setupIntent.metadata?.kind !== 'trial_card' ||
		customerOnIntent !== billing.stripe_customer_id
	) {
		throw new TrialCardError(
			400,
			'BAD_REQUEST',
			'This card setup does not belong to this workspace',
		)
	}
	if (setupIntent.status !== 'succeeded') {
		throw new TrialCardError(400, 'BAD_REQUEST', 'The card setup did not finish')
	}
	const paymentMethod = setupIntent.payment_method
	if (!paymentMethod || typeof paymentMethod === 'string' || paymentMethod.type !== 'card') {
		throw new TrialCardError(400, 'BAD_REQUEST', 'The card setup has no card')
	}
	const card = paymentMethod.card
	if (!card) throw new TrialCardError(400, 'BAD_REQUEST', 'The card setup has no card')
	const wallet = trialWalletOf(card)

	const result = await recordTrialStart({
		db,
		workspaceId,
		fingerprint: card.fingerprint ?? null,
		wallet,
		customerId: billing.stripe_customer_id,
		nowSec: params.nowSec ?? Math.floor(Date.now() / 1000),
	})

	if (result.outcome === 'duplicate') {
		void capturePosthogEvent('trial_card_rejected_duplicate', actorId, {
			workspace_id: workspaceId,
			wallet_type: wallet,
		})
		// The refused card must not stay saved on the customer. Best effort: the refusal stands
		// either way.
		await stripe.paymentMethods
			.detach(paymentMethod.id)
			.catch((err) =>
				logger.warn('Could not detach a refused trial card', { workspaceId, error: String(err) }),
			)
		throw new TrialCardAlreadyUsedError()
	}
	if (result.outcome === 'not_waiting') {
		throw new TrialCardError(409, 'CONFLICT', 'This workspace is not waiting for a card')
	}
	if (result.outcome === 'already_started') return { trialEndsAt: result.periodEnd }

	// The saved card is the one a later plan checkout and the customer portal show. Best effort:
	// the trial has started either way.
	await stripe.customers
		.update(billing.stripe_customer_id, {
			invoice_settings: { default_payment_method: paymentMethod.id },
		})
		.catch((err) =>
			logger.warn('Could not set the default card on the trial customer', {
				workspaceId,
				error: String(err),
			}),
		)

	evictBillingUsage(workspaceId)
	void capturePosthogEvent('trial_started', actorId, {
		workspace_id: workspaceId,
		plan: 'trial',
		card_present: true,
		wallet_type: wallet,
		promo: false,
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
