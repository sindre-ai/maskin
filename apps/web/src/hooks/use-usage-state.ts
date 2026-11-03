import { useBillingUsage } from '@/hooks/use-billing'
import type { BillingUsageResponse } from '@/lib/api'

export type CreditsState = 'empty' | 'ok' | 'unknown'

export interface UsageState {
	credits_state: CreditsState
	usage: BillingUsageResponse | undefined
}

/**
 * Workspace-scoped selector over `useBillingUsage()` that flattens the usage
 * shape into the discrete states the object-detail meta row's D6 chip reads
 * from (verbatim `credits_state === 'empty'` from the SPEC). Kept on top of
 * the existing hook rather than a new endpoint — new sessions cannot begin
 * on this workspace iff:
 *
 *   - the workspace burned every included dollar of the plan cap, AND
 *   - the prepaid `credit_balance_cents` bucket is empty,
 *
 * mirroring the guard `credit-classifier.ts` uses on the backend to surface
 * `credit_balance_low`. Enterprise workspaces are billed elsewhere and never
 * reach the empty state — see `isEnterprise` in `apps/dev/src/routes/billing.ts`.
 *
 * Returns `'unknown'` until the hook resolves so the chip stays absent
 * rather than flashing on a not-yet-loaded workspace.
 */
export function useUsageState(workspaceId: string): UsageState {
	const { data: usage } = useBillingUsage(workspaceId)

	if (!usage) return { credits_state: 'unknown', usage: undefined }

	if (usage.plan === 'enterprise') return { credits_state: 'ok', usage }

	const cap = usage.hard_cap_usd_cents ?? Number.POSITIVE_INFINITY
	const includedRemainingCents = Math.max(0, cap - usage.usd_cents_used)
	const usableCents = includedRemainingCents + usage.credit_balance_cents

	return { credits_state: usableCents <= 0 ? 'empty' : 'ok', usage }
}
