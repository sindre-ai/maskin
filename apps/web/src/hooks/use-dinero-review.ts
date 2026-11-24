import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useDineroReviewLog(workspaceId: string, from: string, to: string) {
	return useQuery({
		queryKey: queryKeys.dineroReview.log(workspaceId, from, to),
		queryFn: () => api.dineroReview.log(workspaceId, from, to),
	})
}

export function useReverseDineroItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (eventId: number) => api.dineroReview.reverse(workspaceId, eventId),
		onSuccess: (result) => {
			if (result.outcome === 'success') toast.success('Reversed in Dinero')
			else toast.error(result.message ?? 'Dinero did not accept the reversal')
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
		onError: (err: Error) => toast.error(err.message),
	})
}

export function useApproveDineroBooks(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (body: { from: string; to: string; figures_hash: string }) =>
			api.dineroReview.approve(workspaceId, body),
		onSuccess: () => {
			toast.success('Books approved')
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
		onError: (err: Error) => {
			toast.error(err.message)
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
	})
}

export function useDineroFilingHandoff(workspaceId: string) {
	return useMutation({
		mutationFn: (body: { from: string; to: string }) =>
			api.dineroReview.filingHandoff(workspaceId, body),
		onError: (err: Error) => toast.error(err.message),
	})
}
