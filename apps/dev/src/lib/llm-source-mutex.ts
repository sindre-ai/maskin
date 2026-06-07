import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { type ApiErrorResponse, createApiError } from './errors'
import { logger } from './logger'
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
 * `hasActivePaidPlan` and the webhook handler both treat `active` as the
 * sole trigger for clearing the other side — see the comment on that
 * function for why `past_due` / `incomplete` are intentionally allowed to
 * coexist with a fresh BYO write.
 */

export type WorkspaceBilling = NonNullable<WorkspaceSettings['billing']>

type ActivePaidBilling = WorkspaceBilling & {
	stripe_subscription_id: string
	status: 'active'
}

/**
 * `true` when the workspace currently has a fully-active Stripe subscription
 * that must be canceled before a BYOLLM source can claim the slot. The
 * status set is intentionally narrower than the webhook's
 * `ACTIVE_PAID_STATUSES` constant: `past_due` and `incomplete` both leave the
 * paid plan pending without confirming it. Specifically:
 *
 *   - `incomplete` = SCA pending. If the user finishes auth, the webhook
 *     flips them to `active` and clears any BYO they may have added in the
 *     meantime. If SCA fails, the sub never activates and the user keeps
 *     their BYO source. Either way, blocking a BYO write here would strand
 *     the user with no working LLM during the SCA window.
 *   - `past_due` = the most recent invoice failed but Stripe is still
 *     retrying. We accept the trade-off of leaving the local billing row in
 *     place — the customer is still being billed until Stripe finally
 *     cancels (or recovers), at which point the webhook reconciles state.
 *
 * The type predicate narrows the input so callers can read
 * `settings.billing.stripe_subscription_id` without a non-null assertion.
 */
export function hasActivePaidPlan(
	settings: Pick<WorkspaceSettings, 'billing'>,
): settings is { billing: ActivePaidBilling } {
	const billing = settings.billing
	if (!billing) return false
	if (!billing.stripe_subscription_id) return false
	return billing.status === 'active'
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
	const next: Record<string, unknown> = { ...settings }
	delete next.custom_llm
	delete next.claude_oauth
	if (next.llm_keys && typeof next.llm_keys === 'object') {
		const { anthropic: _, ...siblingKeys } = next.llm_keys as Record<string, unknown>
		next.llm_keys = siblingKeys
	}
	return next
}

/**
 * `true` when the incoming PATCH body is adding/enabling a BYOLLM source.
 * Only triggers the mutex when the write is actually setting a non-empty
 * key — a deletion (`llm_keys.anthropic = null`), a custom_llm disable, or
 * an empty/whitespace-only key should not cancel a paid plan, since the
 * user isn't actually selecting BYO. Empty-string anthropic keys are
 * additionally rejected at the schema layer so they never reach this point,
 * but the trim check here is defense in depth.
 */
export function patchAddsByoSource(patchSettings: Partial<WorkspaceSettings>): boolean {
	const anthropic = patchSettings.llm_keys?.anthropic
	if (typeof anthropic === 'string' && anthropic.trim().length > 0) return true
	const custom = patchSettings.custom_llm
	if (custom?.enabled === true && typeof custom.api_key === 'string' && custom.api_key.length > 0) {
		return true
	}
	return false
}

/**
 * Outcome of the locked BYO transition. On `ok: false`, the caller should
 * surface the API error at the matching HTTP status without writing the row.
 */
export type ByoTransitionResult<TUpdatedRow> =
	| { ok: true; updated: TUpdatedRow }
	| { ok: false; status: 404 | 500; error: ApiErrorResponse }

type CancelAndDowngradeArgs<TUpdatedRow extends Record<string, unknown>> = {
	db: Database
	workspaceId: string
	/**
	 * Lazy — only constructed when the locked row has an active paid plan
	 * that actually needs canceling. Allows the caller to skip env reads on
	 * the no-paid-plan path and to surface a `Stripe is not configured`
	 * error before opening the transaction.
	 */
	getStripe: () => Stripe
	/** Distinguishes log lines between PATCH and OAuth-import flows. */
	flow: 'BYOLLM transition' | 'Claude OAuth import'
	/**
	 * Called inside the row lock with the freshly-read settings. Return the
	 * full settings object to persist. If the locked row had an active paid
	 * plan, the cancel has already succeeded and `downgradedBilling` is the
	 * billing block to embed; otherwise it's `undefined` and the caller
	 * should leave the existing billing block alone (or copy it through).
	 */
	buildNextSettings: (
		lockedSettings: Record<string, unknown>,
		downgradedBilling: WorkspaceSettings['billing'] | undefined,
	) => Record<string, unknown>
	/**
	 * Optional non-`settings` column writes (e.g. `name`) to fold into the
	 * same UPDATE so the whole transition lands as a single row write.
	 */
	extraSet?: Record<string, unknown>
}

/**
 * Shared by PATCH /api/workspaces/:id and POST /api/claude-oauth/import.
 *
 * Wraps the read-cancel-rewrite window in a single transaction with a
 * `SELECT … FOR UPDATE` on the workspaces row, so a concurrent PATCH +
 * webhook can't race and leave the workspace claiming both BYO and a paid
 * plan are active. The Stripe cancel happens inside the lock — the row
 * stays exclusive for the duration of the network call, which for a single
 * workspace is the right trade-off (only writers to the same row block).
 */
export async function cancelPaidPlanAndDowngrade<TUpdatedRow extends Record<string, unknown>>(
	args: CancelAndDowngradeArgs<TUpdatedRow>,
): Promise<ByoTransitionResult<TUpdatedRow>> {
	const { db, workspaceId, getStripe, flow, buildNextSettings, extraSet } = args

	return await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)

		if (!locked) {
			return {
				ok: false as const,
				status: 404 as const,
				error: createApiError('NOT_FOUND', 'Workspace not found'),
			}
		}

		const lockedSettings = (locked.settings ?? {}) as Record<string, unknown>
		const lockedBilling = lockedSettings.billing as WorkspaceSettings['billing'] | undefined

		let downgradedBilling: WorkspaceSettings['billing'] | undefined
		if (hasActivePaidPlan({ billing: lockedBilling })) {
			let stripe: Stripe
			try {
				stripe = getStripe()
			} catch (err) {
				logger.error(`Cannot cancel paid plan during ${flow}: Stripe is not configured`, {
					workspaceId,
					error: err instanceof Error ? err.message : String(err),
				})
				return {
					ok: false as const,
					status: 500 as const,
					error: createApiError('INTERNAL_ERROR', 'Stripe is not configured'),
				}
			}
			try {
				await cancelActivePaidSubscription(stripe, lockedBilling.stripe_subscription_id)
			} catch (err) {
				logger.error(`Stripe subscription cancel failed during ${flow}`, {
					workspaceId,
					subscriptionId: lockedBilling.stripe_subscription_id,
					error: err instanceof Error ? err.message : String(err),
				})
				return {
					ok: false as const,
					status: 500 as const,
					error: createApiError('INTERNAL_ERROR', 'Failed to cancel paid subscription'),
				}
			}
			downgradedBilling = billingAfterByoTransition(lockedBilling)
			logger.info(`Paid plan canceled during ${flow}`, {
				workspaceId,
				subscriptionId: lockedBilling.stripe_subscription_id,
			})
		}

		const nextSettings = buildNextSettings(lockedSettings, downgradedBilling)

		const [updated] = await tx
			.update(workspaces)
			.set({ settings: nextSettings, updatedAt: new Date(), ...(extraSet ?? {}) })
			.where(eq(workspaces.id, workspaceId))
			.returning()

		if (!updated) {
			return {
				ok: false as const,
				status: 404 as const,
				error: createApiError('NOT_FOUND', 'Workspace not found'),
			}
		}

		return { ok: true as const, updated: updated as unknown as TUpdatedRow }
	})
}
