import type { Database } from '@maskin/db'
import { events, sessions, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import { isEnterpriseWorkspace } from './enterprise'
import {
	canUseCreditBalance,
	getWorkspacePlanCap,
	getWorkspacePlanUsdCentsUsage,
} from './llm-routing'
import { logger } from './logger'
import type { MaskinCreditsCurrency } from './stripe'
import type { WorkspaceSettings } from './types'

// ── Delta 1b — custom-amount top-up volume bonus tiers ─────────────────────
//
// Threshold amounts in USD MINOR UNITS (i.e. cents). Pinned to the current
// maskin_credits_growth ($250 = 25000 cents) and maskin_credits_scale
// ($1000 = 100000 cents) Stripe Price amounts per the 7 Sep Pricing
// lock-down comment on the parent bet. If Stripe rotates those Price
// amounts the boot-time sanity check below fires a warn log; the constants
// stay authoritative because the volume bonus is an application-level
// benefit, not an on-Stripe promotion.
//
// Source of truth (Stripe):
//   maskin_credits_growth  → 25000 USD cents (10% pack)
//   maskin_credits_scale   → 100000 USD cents (20% pack)
// Verified live against sk_live_… on 7 Sep by Pricing Strategist.
export const GROWTH_THRESHOLD_USD_MINOR = 25_000
export const SCALE_THRESHOLD_USD_MINOR = 100_000
export const GROWTH_BONUS = 0.1
export const SCALE_BONUS = 0.2

/**
 * USD-equivalent normalisation reference for the volume-bonus tier check
 * (bet spec Delta 1b, Item 9): $50 = 349 DKK = 45 EUR. This is a bonus tier
 * classification, NOT a payment or Stripe amount — we deliberately do NOT
 * do live FX here. Live FX for the money side of the transaction happens
 * inside Stripe / Adaptive Pricing.
 */
const USD_EQUIV_50_USD_MINOR = 5000
const USD_EQUIV_349_DKK_MINOR = 34900
const USD_EQUIV_45_EUR_MINOR = 4500

/**
 * Convert a minor-unit amount in `currency` into USD minor units using the
 * fixed reference above. Used ONLY to decide which bonus tier applies to a
 * custom-amount top-up; do not call this from any code that touches money.
 */
export function normalizeToUsdMinor(amountMinor: number, currency: MaskinCreditsCurrency): number {
	if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 0
	switch (currency) {
		case 'usd':
			return Math.round(amountMinor)
		case 'dkk':
			// $50 = 349 DKK  →  ratio = 5000 / 34900
			return Math.round((amountMinor * USD_EQUIV_50_USD_MINOR) / USD_EQUIV_349_DKK_MINOR)
		case 'eur':
			// $50 = 45 EUR  →  ratio = 5000 / 4500
			return Math.round((amountMinor * USD_EQUIV_50_USD_MINOR) / USD_EQUIV_45_EUR_MINOR)
	}
}

/**
 * Delta 1b: volume-bonus tier for a custom-amount top-up.
 *
 * Returns the multiplier used to compute bonus credits — 0 / 0.10 / 0.20 —
 * keyed off the USD-equivalent of the paid amount. Scale-first check per the
 * 7 Sep Pricing lock-down (the naive Growth-first order would misclassify a
 * Scale-tier top-up as Growth and under-award). Callers apply the bonus at
 * ledger-write time — see routes/stripe-webhook.ts's credit-topup branch and
 * the awaiting-vies release path (Task 2's fulfilFromAwaitingRow).
 */
export function bonusFor(amountMinor: number, currency: MaskinCreditsCurrency): number {
	const usdEquivMinor = normalizeToUsdMinor(amountMinor, currency)
	if (usdEquivMinor >= SCALE_THRESHOLD_USD_MINOR) return SCALE_BONUS
	if (usdEquivMinor >= GROWTH_THRESHOLD_USD_MINOR) return GROWTH_BONUS
	return 0
}

/**
 * Boot-time sanity check: does the live Stripe Growth/Scale pack amount still
 * match our hardcoded threshold? Called from the app boot path so a Pricing
 * change on Stripe surfaces as a warn log instead of a silent tier mismatch.
 * Never throws — a Stripe outage or a missing price must not take the app
 * down at boot over an application-level bonus classification.
 */
export async function verifyVolumeBonusThresholds(stripe: Stripe): Promise<void> {
	const checks: Array<{ lookupKey: string; expectedMinor: number }> = [
		{ lookupKey: 'maskin_credits_growth', expectedMinor: GROWTH_THRESHOLD_USD_MINOR },
		{ lookupKey: 'maskin_credits_scale', expectedMinor: SCALE_THRESHOLD_USD_MINOR },
	]
	for (const { lookupKey, expectedMinor } of checks) {
		try {
			const list = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
			const price = list.data[0]
			if (!price) {
				logger.warn('bonusFor: Stripe Price lookup returned nothing', { lookupKey })
				continue
			}
			if (typeof price.unit_amount === 'number' && price.unit_amount !== expectedMinor) {
				logger.warn(
					'bonusFor: live Stripe Price amount diverges from hardcoded threshold — bonus tiers may under/over-award',
					{ lookupKey, live: price.unit_amount, hardcoded: expectedMinor },
				)
			}
		} catch (err) {
			logger.warn('bonusFor: Stripe threshold check failed', {
				lookupKey,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}

/**
 * Debits the workspace's prepaid credit balance for the dollar cost this
 * session incurred beyond the plan's included cap. Both `used` and `cap` are
 * already USD cents (see `getWorkspacePlanUsdCentsUsage`), so — unlike the
 * flat per-token rate this replaced — no token→dollar conversion happens
 * here: the overage is real cost, reflecting whichever model tier actually
 * ran.
 *
 * TWO distinct things have to be idempotent here, and they need different
 * mechanisms:
 *
 *  1. The SAME segment of a session being billed twice (crash/retry).
 *     Handled by the partial unique index on
 *     (`session_id`, `session_usage_cents`) — the retry carries the same
 *     cumulative session cost, so the second insert conflicts, returns no
 *     row, and this is a no-op. The key is segmented rather than keyed on
 *     `session_id` alone because this runs on PAUSE as well as completion:
 *     one row per session meant a paused-then-resumed session never got
 *     billed for anything it spent after the resume (migration 0064).
 *
 *  2. DIFFERENT sessions in the same period each seeing an overlapping
 *     overage. `getWorkspacePlanUsdCentsUsage` returns usage for the WHOLE
 *     period, so `used - cap` is the period's total overage, not this
 *     session's slice. Billing that directly re-charged the running total on
 *     every session past the cap: two $20 sessions against a $10 cap took $10
 *     then $30 = $40, for $30 of real overage. Fixed by subtracting what
 *     prior debits already accounted for (`accounted_overage_cents` summed
 *     over the period) so each session pays only its increment.
 *
 * `accounted_overage_cents` is tracked separately from `amountCents` because
 * a session that outspends the balance has the excess written off (see the
 * clamp below); summing the clamped `amountCents` instead would re-bill those
 * written-off cents the next time the workspace tops up.
 *
 * Everything that feeds the arithmetic — the usage read, the prior-debit sum,
 * and the balance — is read inside the `FOR UPDATE` transaction, so two
 * sessions completing concurrently serialize instead of both billing off the
 * same pre-state.
 *
 * Unlike the old block-based overage reporter this replaces, this never
 * calls Stripe: the balance was already paid for at top-up time
 * (`routes/stripe-webhook.ts`'s credit-topup branch), so the only failure
 * mode here is a local DB write — logged by the caller (session-manager.ts
 * fires this fire-and-forget), not retried by a background reconciler, since
 * there's nothing external left to reconcile.
 */
export async function debitCreditForSession(params: {
	db: Database
	workspaceId: string
	sessionId: string
	actorId: string
	wsSettings: WorkspaceSettings
}): Promise<void> {
	const { db, workspaceId, sessionId, actorId, wsSettings } = params
	const billing = wsSettings.billing
	if (billing?.plan !== 'pro' && billing?.plan !== 'team') return
	if (!canUseCreditBalance(billing.plan, billing)) return
	if (await isEnterpriseWorkspace(db, workspaceId)) return

	const capCents = getWorkspacePlanCap(wsSettings)
	if (capCents === null) return

	const periodStartMs =
		typeof billing.period_start === 'number' ? billing.period_start * 1000 : undefined

	await db.transaction(async (tx) => {
		// Row-locked read (mirrors routes/stripe-webhook.ts's applyEvent) so a
		// concurrent top-up or another session's debit on the same workspace
		// can't race this read-modify-write. Taken FIRST so every read below —
		// cumulative usage, prior accounted overage, balance — sees one
		// consistent, serialized view of the workspace.
		const [workspace] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!workspace) return

		const usedCents = await getWorkspacePlanUsdCentsUsage(tx, workspaceId, periodStartMs)
		const totalOverageCents = Math.max(0, usedCents - capCents)
		if (totalOverageCents <= 0) return

		// What earlier sessions in this period already billed. Scoped by the
		// same period boundary as the usage read above so the two sides of the
		// subtraction always describe the same window — an unscoped sum would
		// carry last period's debits into this period and under-bill.
		const periodDebitConds = [
			eq(workspaceCreditLedger.workspaceId, workspaceId),
			eq(workspaceCreditLedger.type, 'debit'),
		]
		if (periodStartMs !== undefined) {
			periodDebitConds.push(gte(workspaceCreditLedger.createdAt, new Date(periodStartMs)))
		}
		const [accountedRow] = await tx
			.select({
				total: sql<string>`COALESCE(SUM(${workspaceCreditLedger.accountedOverageCents}), 0)`,
			})
			.from(workspaceCreditLedger)
			.where(and(...periodDebitConds))
		// SUM() comes back as a string from postgres.js (bigint-safe); Number()
		// is safe here because the value is a cents total bounded by the
		// period's spend, but guard anyway so a NULL/garbage read can't turn
		// into a NaN debit.
		const alreadyAccountedCents = Math.max(0, Number(accountedRow?.total ?? 0) || 0)

		// This session's own slice of the period's overage.
		const costCents = Math.max(0, totalOverageCents - alreadyAccountedCents)
		if (costCents <= 0) return

		// The parse is a READ of `billing` only — never the write base. Zod
		// strips unknown keys and `workspaceSettingsSchema` is not a
		// passthrough, so carrying the parsed object into the UPDATE below
		// silently dropped every settings key the schema doesn't model, and a
		// parse failure (`?? {}`) replaced the whole object — wiping
		// claude_oauth, custom_extensions, statuses, pinned_files. The raw row
		// is the carrier; this matches routes/stripe-webhook.ts and
		// routes/test-grants.ts.
		const rawSettings = (workspace.settings ?? {}) as Record<string, unknown>
		const parsed = workspaceSettingsSchema.partial().safeParse(rawSettings)
		if (!parsed.success) {
			logger.warn('debitCreditForSession: settings failed schema parse — reading billing raw', {
				workspaceId,
				sessionId,
			})
		}
		const currentBilling = parsed.data?.billing ?? { plan: billing.plan }
		const currentBalance =
			typeof currentBilling.credit_balance_cents === 'number' &&
			currentBilling.credit_balance_cents > 0
				? Math.floor(currentBilling.credit_balance_cents)
				: 0

		// A session that outspends the remaining balance writes off the excess
		// rather than going negative — the *next* session is what gets
		// hard-blocked by checkPlanCap. The write-off is why the ledger records
		// `accountedOverageCents` (the full slice, below) separately from
		// `amountCents` (the clamped money): the excess is forgiven, so it must
		// not come back as a charge after the next top-up.
		const actualDebitCents = Math.min(costCents, currentBalance)
		const balanceAfter = currentBalance - actualDebitCents

		// This session's OWN cumulative cost, which segments the idempotency
		// key below. `sessionId` alone can't be the key: this function runs on
		// pause as well as on completion, so a session that paused at $30 of
		// overage, resumed, and burned another $200 saw its completion insert
		// conflict and return before debiting — the $200 was silently never
		// charged, and pausing between turns is the norm for interactive
		// sessions. Read inside the same lock as everything else.
		const [sessionRow] = await tx
			.select({ totalCostUsd: sessions.totalCostUsd })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		const sessionUsageCents = Math.max(0, Math.round(Number(sessionRow?.totalCostUsd ?? 0) * 100))

		const claimed = await tx
			.insert(workspaceCreditLedger)
			.values({
				workspaceId,
				sessionId,
				sessionUsageCents,
				type: 'debit',
				amountCents: -actualDebitCents,
				balanceAfterCents: balanceAfter,
				accountedOverageCents: costCents,
			})
			.onConflictDoNothing({
				target: [workspaceCreditLedger.sessionId, workspaceCreditLedger.sessionUsageCents],
				where: sql`${workspaceCreditLedger.type} = 'debit' AND ${workspaceCreditLedger.sessionId} IS NOT NULL`,
			})
			.returning({ id: workspaceCreditLedger.id })

		// 0 rows back means this exact segment was already claimed (and
		// debited) — a retry at the same cumulative cost. Leave the balance
		// untouched. A later segment that actually spent more carries a higher
		// `sessionUsageCents`, so it does not conflict and bills its increment.
		if (!claimed[0]?.id) return

		await tx
			.update(workspaces)
			.set({
				settings: {
					...rawSettings,
					billing: { ...currentBilling, credit_balance_cents: balanceAfter },
				},
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))

		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'session_credit_debited',
			entityType: 'session',
			entityId: sessionId,
			data: {
				usd_cents_over_cap: costCents,
				debited_cents: actualDebitCents,
				balance_after_cents: balanceAfter,
			},
		})
	})
}
