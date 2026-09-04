import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import {
	LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS,
	getConnectedLinkedInIdentityCount,
} from './linkedin-addon'
import { logger } from './logger'
import {
	type StripeEnv,
	createLinkedInAddonCheckoutSession,
	getStripeClient,
	readStripeEnv,
} from './stripe'

/**
 * Keeps the Stripe side of the LinkedIn Identity add-on in step with the
 * number of connected identities on a workspace.
 *
 * The add-on bills two different ways, because it has to work for a workspace
 * that may have no subscription at all:
 *
 *   pro / team — a subscription ITEM on the existing plan subscription, so
 *     the $49/identity line lands on the same invoice, on the same
 *     anniversary, as the plan. This is the common case.
 *   trial — its own single-line subscription, created by its own Checkout
 *     (there is no plan subscription to hang an item on).
 *
 * Quantity is always recomputed from the database — the count of `active`
 * `linkedin-unipile` rows — never incremented or decremented from a previous
 * value. A drifted counter would silently over- or under-bill and nothing
 * would ever correct it; recomputing means the worst case of a missed sync is
 * one stale period, self-healing on the next connect or disconnect.
 *
 * Disconnects use `proration_behavior: 'none'` (a product decision): the
 * identity stays billed until the end of the period it was connected in,
 * rather than generating a mid-period credit.
 */

/** Stripe writes proration credits on quantity changes unless told not to. */
const PRORATION_BEHAVIOR = 'none' as const

export type AddonSyncResult =
	| { status: 'synced'; quantity: number }
	| { status: 'removed' }
	| { status: 'noop'; reason: string }
	/**
	 * The workspace has connected identities but nothing to bill them on — no
	 * plan subscription and no add-on subscription. The caller must send the
	 * user through `startLinkedInAddonCheckout` before the connection can be
	 * considered paid for.
	 */
	| { status: 'checkout_required'; quantity: number }

interface WorkspaceBilling {
	plan?: string
	stripe_customer_id?: string | null
	stripe_subscription_id?: string | null
	linkedin_addon_subscription_id?: string | null
	linkedin_addon_item_id?: string | null
	[key: string]: unknown
}

function readBilling(settings: unknown): WorkspaceBilling {
	if (!settings || typeof settings !== 'object') return {}
	const billing = (settings as Record<string, unknown>).billing
	if (!billing || typeof billing !== 'object') return {}
	return billing as WorkspaceBilling
}

async function writeBilling(
	db: Database,
	workspaceId: string,
	patch: Partial<WorkspaceBilling>,
): Promise<void> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!row) return
	const settings = (row.settings ?? {}) as Record<string, unknown>
	await db
		.update(workspaces)
		.set({ settings: { ...settings, billing: { ...readBilling(settings), ...patch } } })
		.where(eq(workspaces.id, workspaceId))
}

/**
 * Reconcile the add-on's Stripe state with the current connected-identity
 * count. Safe to call after any connect or disconnect, and idempotent — it
 * reads the desired quantity from the database every time.
 *
 * Never throws on a Stripe failure: a billing hiccup must not roll back a
 * connect the user already completed in Unipile's wizard, nor block a
 * disconnect. Failures are logged and the next call re-reconciles.
 */
export async function syncLinkedInAddonQuantity(
	db: Database,
	workspaceId: string,
	deps?: { stripe?: Stripe; env?: StripeEnv },
): Promise<AddonSyncResult> {
	let env: StripeEnv
	try {
		env = deps?.env ?? readStripeEnv()
	} catch (err) {
		logger.warn('LinkedIn add-on sync skipped — Stripe env unavailable', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return { status: 'noop', reason: 'stripe_env_unavailable' }
	}
	if (!env.priceLinkedinIdentity) {
		// Deliberately a warning, not a throw: the identity is connected and
		// usable either way, but somebody needs to know it is not being billed.
		logger.warn('LinkedIn identity connected but STRIPE_PRICE_LINKEDIN_IDENTITY is unset', {
			workspaceId,
		})
		return { status: 'noop', reason: 'price_not_configured' }
	}

	const quantity = await getConnectedLinkedInIdentityCount(db, workspaceId)
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!row) return { status: 'noop', reason: 'workspace_not_found' }
	const billing = readBilling(row.settings)
	const stripe = deps?.stripe ?? getStripeClient(env)

	try {
		// An existing item — on either subscription shape — is just a quantity
		// update. Removing it at zero rather than setting quantity 0 keeps the
		// invoice free of a $0 line.
		if (billing.linkedin_addon_item_id) {
			if (quantity === 0) {
				await stripe.subscriptionItems.del(billing.linkedin_addon_item_id, {
					proration_behavior: PRORATION_BEHAVIOR,
				})
				// The add-on's own subscription id is deliberately left in place:
				// Stripe cancels a subscription whose last item is removed, and a
				// later reconnect creates a fresh item. Clearing it here would
				// lose the pointer the webhook uses to recognise add-on events.
				await writeBilling(db, workspaceId, { linkedin_addon_item_id: null })
				logger.info('LinkedIn add-on item removed — no connected identities', { workspaceId })
				return { status: 'removed' }
			}
			await stripe.subscriptionItems.update(billing.linkedin_addon_item_id, {
				quantity,
				proration_behavior: PRORATION_BEHAVIOR,
			})
			logger.info('LinkedIn add-on quantity synced', { workspaceId, quantity })
			return { status: 'synced', quantity }
		}

		if (quantity === 0) return { status: 'noop', reason: 'nothing_connected' }

		// No item yet. Attach one to the plan subscription when there is one.
		if (billing.stripe_subscription_id) {
			const item = await stripe.subscriptionItems.create({
				subscription: billing.stripe_subscription_id,
				price: env.priceLinkedinIdentity,
				quantity,
				proration_behavior: PRORATION_BEHAVIOR,
			})
			await writeBilling(db, workspaceId, { linkedin_addon_item_id: item.id })
			logger.info('LinkedIn add-on item created on the plan subscription', {
				workspaceId,
				quantity,
				itemId: item.id,
			})
			return { status: 'synced', quantity }
		}

		// Trial: nothing to attach to. The caller has to run a Checkout.
		return { status: 'checkout_required', quantity }
	} catch (err) {
		logger.error('LinkedIn add-on Stripe sync failed', {
			workspaceId,
			quantity,
			error: err instanceof Error ? err.message : String(err),
		})
		return { status: 'noop', reason: 'stripe_error' }
	}
}

/**
 * Start the standalone add-on Checkout for a workspace with no plan
 * subscription. Returns the URL the browser should be sent to, or null when
 * the session could not be created — the caller falls back to the normal
 * post-connect redirect rather than stranding the user.
 */
export async function startLinkedInAddonCheckout(
	db: Database,
	workspaceId: string,
	urls: { successUrl: string; cancelUrl: string },
	deps?: { stripe?: Stripe; env?: StripeEnv },
): Promise<string | null> {
	let env: StripeEnv
	try {
		env = deps?.env ?? readStripeEnv()
	} catch {
		return null
	}
	if (!env.priceLinkedinIdentity) return null
	const quantity = await getConnectedLinkedInIdentityCount(db, workspaceId)
	if (quantity === 0) return null
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const billing = readBilling(row?.settings)
	try {
		const stripe = deps?.stripe ?? getStripeClient(env)
		const session = await createLinkedInAddonCheckoutSession(
			stripe,
			{
				workspaceId,
				quantity,
				successUrl: urls.successUrl,
				cancelUrl: urls.cancelUrl,
				existingCustomerId: billing.stripe_customer_id ?? null,
			},
			env,
		)
		return session.url ?? null
	} catch (err) {
		logger.error('LinkedIn add-on checkout could not be created', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/** Re-exported so the plan surface and the disclosure copy read one constant. */
export { LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS }
