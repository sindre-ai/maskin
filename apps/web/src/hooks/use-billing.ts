import { type BillingCheckoutInput, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery } from '@tanstack/react-query'

/**
 * Subscription state + tokens used this period for a workspace.
 *
 * Shared between the Settings → LLM subscription row and the usage-state banner
 * (Task be5d94b7) — both surface the same numbers, so they read from the same
 * hook to stay in lockstep when the webhook flips a plan or a session burns
 * tokens.
 */
export function useBillingUsage(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.billing.usage(workspaceId),
		queryFn: () => api.billing.usage(workspaceId),
		enabled: Boolean(workspaceId),
		staleTime: 30_000,
	})
}

export function useStripeCheckout(workspaceId: string) {
	return useMutation({
		mutationFn: (input: BillingCheckoutInput) => api.billing.checkout(workspaceId, input),
	})
}
