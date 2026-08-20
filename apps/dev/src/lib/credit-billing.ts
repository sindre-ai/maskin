import type { Database } from '@maskin/db'
import { events, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
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
 * ran. Idempotent per session via the partial unique index on
 * `workspace_credit_ledger.session_id` — a re-fired completion (crash/retry)
 * is a safe no-op, not a double-debit.
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
	const usedCents = await getWorkspacePlanUsdCentsUsage(db, workspaceId, periodStartMs)
	const costCents = Math.max(0, usedCents - capCents)
	if (costCents <= 0) return

	await db.transaction(async (tx) => {
		const claimed = await tx
			.insert(workspaceCreditLedger)
			.values({
				workspaceId,
				sessionId,
				type: 'debit',
				// Placeholder — overwritten below once the actual (possibly
				// clamped) debit is known. The claim itself, not these numbers,
				// is what the idempotency index protects.
				amountCents: 0,
				balanceAfterCents: 0,
			})
			.onConflictDoNothing({
				target: [workspaceCreditLedger.sessionId],
				where: sql`${workspaceCreditLedger.type} = 'debit' AND ${workspaceCreditLedger.sessionId} IS NOT NULL`,
			})
			.returning({ id: workspaceCreditLedger.id })

		// 0 rows back means another completion already claimed (and debited)
		// this session — nothing left to do.
		const claimId = claimed[0]?.id
		if (!claimId) return

		// Row-locked read (mirrors routes/stripe-webhook.ts's applyEvent) so a
		// concurrent top-up or another session's debit on the same workspace
		// can't race this read-modify-write.
		const [workspace] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!workspace) return

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
		// hard-blocked by checkPlanCap.
		const actualDebitCents = Math.min(costCents, currentBalance)
		const balanceAfter = currentBalance - actualDebitCents

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

		await tx
			.update(workspaceCreditLedger)
			.set({ amountCents: -actualDebitCents, balanceAfterCents: balanceAfter })
			.where(eq(workspaceCreditLedger.id, claimId))

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
