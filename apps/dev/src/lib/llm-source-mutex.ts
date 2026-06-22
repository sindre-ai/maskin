import type Stripe from 'stripe'
import type { WorkspaceSettings } from './types'

/**
 * Backend mutex between BYOLLM sources (BYO Anthropic key, custom_llm,
 * Claude OAuth) and a paid Maskin plan. When a write picks one side, the
 * other side is cleared in the same DB update so a workspace never claims
 * both are active.
 *
 * Two transitions:
 *
 *  1. User adds a BYOLLM source → cancel Stripe subscription via API, then
 *     write `billing.plan = 'byollm'`, `status = 'canceled'`, drop the
 *     subscription id. Cancel runs BEFORE the DB write so a Stripe failure
 *     surfaces 5xx instead of leaving the customer charged while the local
 *     row says BYO.
 *
 *  2. Stripe webhook flips the workspace to an `active` paid plan → drop
 *     `llm_keys.anthropic`, `custom_llm`, `claude_oauth` from settings in
 *     the same workspace update the webhook handler already performs.
 *
 * Pure functions here — side effects (Stripe cancel) live in
 * `cancelActivePaidSubscription`. The webhook side has no remote call.
 */

const ACTIVE_PAID_STATUSES = new Set(['active', 'past_due', 'incomplete'])

/**
 * `true` when the workspace currently has a Stripe subscription that should
 * be canceled before a BYOLLM source can claim the slot. `canceled` rows or
 * rows with no `stripe_subscription_id` are already inactive.
 */
export function hasActivePaidPlan(settings: Pick<WorkspaceSettings, 'billing'>): boolean {
	const billing = settings.billing
	if (!billing) return false
	if (!billing.stripe_subscription_id) return false
	if (!billing.status) return false
	return ACTIVE_PAID_STATUSES.has(billing.status)
}

/**
 * Cancel the workspace's live Stripe subscription. Treats "already gone"
 * errors as success so a stale Stripe state doesn't block the BYOLLM
 * transition forever. All other errors propagate — the caller is expected
 * to surface them as 5xx and skip the local write.
 *
 * Stripe SDK error shape: `err.code === 'resource_missing'` when the
 * subscription was already canceled or never existed.
 */
export async function cancelActivePaidSubscription(
	stripe: Stripe,
	subscriptionId: string,
): Promise<void> {
	try {
		await stripe.subscriptions.cancel(subscriptionId)
	} catch (err) {
		if (isStripeMissingResourceError(err)) return
		throw err
	}
}

function isStripeMissingResourceError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const e = err as { code?: string; type?: string; statusCode?: number }
	if (e.code === 'resource_missing') return true
	// Stripe SDK also raises StripeInvalidRequestError with statusCode 404
	// when canceling an already-deleted sub on some plans.
	if (e.type === 'StripeInvalidRequestError' && e.statusCode === 404) return true
	return false
}

/**
 * Apply the `billing` half of the BYOLLM transition to the existing
 * settings. Returns the new `billing` block (or `undefined` to leave it
 * untouched when there's no active paid plan to clear). Caller merges the
 * result into the workspace update.
 */
export function billingAfterByoTransition(
	current: WorkspaceSettings['billing'] | undefined,
): WorkspaceSettings['billing'] | undefined {
	if (!current) return undefined
	if (!current.stripe_subscription_id && current.status === 'canceled') return current
	return {
		...current,
		plan: 'byollm',
		stripe_subscription_id: null,
		status: 'canceled',
	}
}

/**
 * Strip every BYOLLM source from a settings object. Used by the Stripe
 * webhook when a paid plan transitions to `active` — the workspace just
 * picked the paid side, so any leftover BYO key, custom_llm config, or
 * Claude OAuth tokens are no longer the active source and must not linger.
 *
 * Returns a NEW settings object (does not mutate the input) with the three
 * BYO slots removed. `llm_keys` is preserved minus `anthropic`; sibling
 * providers (e.g. `openai`) stay because they're not in the mutex.
 */
export function settingsAfterPaidPlanActivation(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const { custom_llm: _drop1, claude_oauth: _drop2, llm_keys, ...rest } = settings
	const next: Record<string, unknown> = { ...rest }
	if (llm_keys && typeof llm_keys === 'object') {
		const { anthropic: _drop3, ...siblingKeys } = llm_keys as Record<string, unknown>
		next.llm_keys = siblingKeys
	}
	return next
}

/**
 * `true` when the incoming PATCH body is adding/enabling a BYOLLM source.
 * Only triggers the mutex when the write is actually setting a key — a
 * deletion (`llm_keys.anthropic = null`) or a custom_llm disable should
 * not cancel a paid plan, since the user isn't picking BYO.
 */
export function patchAddsByoSource(patchSettings: Partial<WorkspaceSettings>): boolean {
	if (patchSettings.llm_keys && typeof patchSettings.llm_keys.anthropic === 'string') return true
	const custom = patchSettings.custom_llm
	if (custom?.enabled === true && typeof custom.api_key === 'string' && custom.api_key.length > 0) {
		return true
	}
	return false
}
