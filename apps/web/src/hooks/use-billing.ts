import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useBillingSummary(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.billing.summary(workspaceId),
		queryFn: () => api.billing.summary(workspaceId),
	})
}

export function useStartCheckout(workspaceId: string) {
	return useMutation({
		mutationFn: (invoiceEmail?: string) => api.billing.startCheckout(workspaceId, invoiceEmail),
	})
}

export function useCompleteCheckout(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			paymentIntentId,
			invoiceEmail,
		}: { paymentIntentId: string; invoiceEmail?: string }) =>
			api.billing.complete(workspaceId, paymentIntentId, invoiceEmail),
		onSuccess: () => {
			toast.success('Payment confirmed — plan activated')
			queryClient.invalidateQueries({ queryKey: queryKeys.billing.all(workspaceId) })
		},
	})
}

export function useOpenPortal(workspaceId: string) {
	return useMutation({
		mutationFn: () => api.billing.portal(workspaceId),
		onSuccess: (data) => {
			window.location.href = data.url
		},
		// A silent `manage` failure looks broken — surface why (e.g. no Stripe
		// customer yet) instead of doing nothing.
		onError: (err) => {
			toast.error(err instanceof Error ? err.message : 'Could not open the Stripe portal')
		},
	})
}
