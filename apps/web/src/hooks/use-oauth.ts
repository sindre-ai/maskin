import type { OauthAuthorizeParams } from '@maskin/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

/** The person's live Claude connections across their workspaces. Listing is never behind the flag. */
export function useOauthGrants() {
	return useQuery({
		queryKey: queryKeys.oauthGrants.all(),
		queryFn: () => api.oauth.listGrants(),
		retry: false,
	})
}

export function useDisconnectGrant() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (grantId: string) => api.oauth.revokeGrant(grantId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.oauthGrants.all() })
			toast.success('Claude disconnected')
		},
	})
}

/**
 * The consent page's check of the authorize request. Every call counts in the funnel, so it
 * never retries or refetches on its own: "Try again" is the person's own refetch.
 */
export function useOauthPreview(params: OauthAuthorizeParams) {
	return useQuery({
		queryKey: ['oauthPreview', params],
		queryFn: () => api.oauth.preview(params),
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	})
}
