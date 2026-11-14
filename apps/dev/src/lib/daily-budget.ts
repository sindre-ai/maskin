import { type BillingPlan, workspaceSettingsSchema } from '@maskin/shared'
import { resolvePlanCapCents } from './billing-defaults'
import { isEnterprise } from './enterprise'

/**
 * The plan limit (USD cents) a daily percent target is a share of: the same stored cap the plan
 * meter divides by (`hard_cap_usd_cents`, else the plan's default). Null for an unmetered
 * (enterprise) workspace, which has no limit to take a percent of.
 *
 * `routes/billing.ts` resolves the same number for the usage read; this is the part a daily
 * target needs, so the setting and the morning card use one definition.
 */
export function resolveWorkspaceCapCents(workspace: {
	settings: unknown
	enterpriseGranted: boolean | null
	billingOwnerId: string | null
}): number | null {
	if (isEnterprise(workspace)) return null
	const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const billing = parsed.success ? parsed.data.billing : undefined
	const plan: BillingPlan = billing?.plan ?? 'trial'
	if (plan === 'enterprise') return null
	return billing?.hard_cap_usd_cents && billing.hard_cap_usd_cents > 0
		? billing.hard_cap_usd_cents
		: resolvePlanCapCents(plan)
}
