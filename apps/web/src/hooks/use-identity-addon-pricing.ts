import { useBillingUsage } from '@/hooks/use-billing'

/**
 * Whether a provider is billed per connected identity, and if so whether this
 * workspace pays for it. LinkedIn is the one provider that costs money to
 * connect — $49 per connected identity per month, added to the workspace
 * subscription — so the price has to be stated before the click that incurs it,
 * on every surface that can start the connect.
 *
 * Both flags are false until the plan is known: `billingUsage` is undefined on
 * first render, and defaulting to the paid copy would flash "$49/month" at an
 * enterprise workspace — the one thing this exists to avoid. Enterprise
 * workspaces get connected identities free (`isEnterprise()` in
 * apps/dev/src/lib/enterprise.ts), so the price must not be stated to them.
 * Kept in sync with LINKEDIN_IDENTITY_UNIT_PRICE_USD_CENTS in
 * apps/dev/src/lib/linkedin-addon.ts.
 */
export function useIdentityAddonPricing(workspaceId: string, providerName: string) {
	const { data: billingUsage } = useBillingUsage(workspaceId)
	const applies = providerName === 'linkedin-unipile' && billingUsage !== undefined
	const isFree = applies && billingUsage?.plan === 'enterprise'
	const isPaid = applies && billingUsage?.plan !== 'enterprise'
	return { isFree, isPaid }
}
