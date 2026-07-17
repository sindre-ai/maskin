import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useLinkedinAccount(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.linkedin.account(workspaceId),
		queryFn: () => api.linkedin.account(workspaceId),
	})
}

/**
 * Kicks off the Unipile hosted-auth handoff and redirects the browser to the
 * returned URL. The user completes LinkedIn login on Unipile, then Unipile
 * redirects them to `/api/linkedin/callback` which upserts the account row and
 * bounces them back to the agent detail page with `?linkedin=connected`.
 */
export function useConnectLinkedin(workspaceId: string) {
	return useMutation({
		mutationFn: (agentId: string) => api.linkedin.connect(workspaceId, agentId),
		onSuccess: (data) => {
			window.location.href = data.url
		},
		onError: (err) => {
			const message = err instanceof Error ? err.message : 'Failed to start LinkedIn connect'
			toast.error(message)
		},
	})
}
