import type { Database } from '@maskin/db'
import { events, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { isEnterpriseWorkspace } from './enterprise-allowlist'
import {
	canUseCreditBalance,
	getWorkspacePlanCap,
	getWorkspacePlanUsdCentsUsage,
} from './llm-routing'
import type { WorkspaceSettings } from './types'

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
 *  1. The SAME session completing twice (crash/retry). Handled by the partial
 *     unique index on `workspace_credit_ledger.session_id` — the second
 *     insert conflicts, returns no row, and this is a no-op.
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

		const currentSettings =
			workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {}).data ?? {}
		const currentBilling = currentSettings.billing ?? { plan: billing.plan }
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

		const claimed = await tx
			.insert(workspaceCreditLedger)
			.values({
				workspaceId,
				sessionId,
				type: 'debit',
				amountCents: -actualDebitCents,
				balanceAfterCents: balanceAfter,
				accountedOverageCents: costCents,
			})
			.onConflictDoNothing({
				target: [workspaceCreditLedger.sessionId],
				where: sql`${workspaceCreditLedger.type} = 'debit' AND ${workspaceCreditLedger.sessionId} IS NOT NULL`,
			})
			.returning({ id: workspaceCreditLedger.id })

		// 0 rows back means another completion already claimed (and debited)
		// this session — leave the balance untouched.
		if (!claimed[0]?.id) return

		await tx
			.update(workspaces)
			.set({
				settings: {
					...currentSettings,
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
