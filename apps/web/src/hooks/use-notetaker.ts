import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function useSendBot(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: { meeting_url: string; title?: string }) =>
			api.notetaker.sendBot(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.list(workspaceId) })
			toast.success('Bot dispatched to meeting')
		},
		onError: (err) => {
			toast.error(err instanceof Error ? err.message : 'Failed to dispatch bot')
		},
	})
}
