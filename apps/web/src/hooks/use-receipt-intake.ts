import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, type ReceiptIntakeStatus, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

/** The receipt ways of one Accounting flow. A flow that is not an Accounting flow answers 404. */
export function useReceiptIntake(workspaceId: string, loopId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.receiptIntake.detail(workspaceId, loopId),
		queryFn: () => api.receiptIntake.get(workspaceId, loopId),
		enabled: enabled && Boolean(workspaceId) && Boolean(loopId),
		retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
	})
}

export function useReceiptIntakeActions(workspaceId: string, loopId: string) {
	const queryClient = useQueryClient()
	const key = queryKeys.receiptIntake.detail(workspaceId, loopId)
	const set = (status: ReceiptIntakeStatus) => queryClient.setQueryData(key, status)
	const onError = () => toast.error('Could not save. Try again.')

	return {
		updateEmail: useMutation({
			mutationFn: (body: {
				enabled?: boolean
				allowed_senders?: string[]
				new_address?: boolean
			}) => api.receiptIntake.updateEmail(workspaceId, loopId, body),
			onSuccess: set,
			onError,
		}),
		createKey: useMutation({
			mutationFn: () => api.receiptIntake.createKey(workspaceId, loopId),
			onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
			onError,
		}),
		revokeKey: useMutation({
			mutationFn: (keyId: string) => api.receiptIntake.revokeKey(workspaceId, loopId, keyId),
			onSuccess: set,
			onError,
		}),
	}
}
