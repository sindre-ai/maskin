import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useIntegrations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.all(workspaceId),
		queryFn: () => api.integrations.list(workspaceId),
	})
}

export function useProviders() {
	return useQuery({
		queryKey: queryKeys.integrations.providers(),
		queryFn: () => api.integrations.providers(),
	})
}

export function useConnectIntegration(workspaceId: string) {
	return useMutation({
		mutationFn: (input: {
			provider: string
			apiKey?: string
			// Resend two-call handshake: both fields travel with the first POST so
			// the backend can hit Resend's `POST /domains` in the same round-trip.
			receiveSubdomain?: string
			// GitHub only: send the user to the App's install page for an org that
			// does not have the App yet, instead of the authorize step that only
			// lists orgs that already do.
			installNewOrg?: boolean
		}) => {
			const body =
				input.apiKey || input.receiveSubdomain || input.installNewOrg
					? {
							...(input.apiKey ? { api_key: input.apiKey } : {}),
							...(input.receiveSubdomain ? { receive_subdomain: input.receiveSubdomain } : {}),
							...(input.installNewOrg ? { install_new_org: true } : {}),
						}
					: undefined
			return api.integrations.connect(workspaceId, input.provider, body)
		},
		onSuccess: (data) => {
			// Manual-auth providers (e.g. Skjald, Resend) return a webhook_url to
			// display instead of an OAuth install_url to redirect to — the caller
			// handles showing it via a per-call onSuccess.
			if (data.webhook_url) return
			if (data.install_url) window.location.href = data.install_url
		},
	})
}

/** Server-side DNS pre-check the Resend connect flow fires on leaving Step 2.
 *  The backend runs `node:dns.resolveMx()` on the entered domain and returns
 *  the existing MX list plus a `warn` flag — set when the user typed a bare
 *  domain that already routes human mail somewhere else, which is the root-MX
 *  gotcha the design spec surfaces as the `s3-root-mx` scene. */
export function useResendDnsPrecheck(workspaceId: string) {
	return useMutation({
		mutationFn: (domain: string) => api.integrations.resendDnsPrecheck(workspaceId, domain),
	})
}

/** GitHub App installations the actor already reaches from another workspace.
 *  GitHub won't re-run its install flow for an org that already has the App, so
 *  binding an existing installation is the only way to add it here. */
export function useLinkableGithubInstallations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.githubLinkable(workspaceId),
		queryFn: () => api.integrations.githubLinkable(workspaceId),
	})
}

export function useLinkGithubInstallation(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (installationId: string) =>
			api.integrations.githubLink(workspaceId, installationId),
		onSuccess: () => {
			toast.success('GitHub organization added to this workspace')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.integrations.githubLinkable(workspaceId),
			})
		},
	})
}

/** Installations the user authorized against on GitHub, awaiting their pick.
 *  Only fetches once the connect callback has redirected back with an id. */
export function useGithubPendingSelection(workspaceId: string, integrationId: string | null) {
	return useQuery({
		queryKey: queryKeys.integrations.githubPendingSelection(workspaceId, integrationId ?? ''),
		queryFn: () => api.integrations.githubPendingSelection(workspaceId, integrationId as string),
		enabled: !!integrationId,
	})
}

export function useSelectGithubInstallation(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			integrationId,
			installationId,
		}: { integrationId: string; installationId: string }) =>
			api.integrations.githubSelectInstallation(workspaceId, integrationId, installationId),
		onSuccess: () => {
			toast.success('GitHub organization connected')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.integrations.githubLinkable(workspaceId),
			})
		},
	})
}

export function useCompleteIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, secret }: { id: string; secret: string }) =>
			api.integrations.complete(id, workspaceId, secret),
		onSuccess: () => {
			toast.success('Integration connected')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

export function useDisconnectIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.integrations.disconnect(id, workspaceId),
		onSuccess: () => {
			toast.success('Integration disconnected')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.integrations.githubLinkable(workspaceId),
			})
		},
	})
}

const FIVE_MINUTES = 5 * 60 * 1000

export function useSlackConversations(
	integrationId: string | undefined,
	workspaceId: string,
	types?: string[],
) {
	const resolvedTypes = types ?? ['public_channel', 'private_channel', 'im', 'mpim']
	return useQuery({
		queryKey: queryKeys.integrations.slackConversations(integrationId ?? '', resolvedTypes),
		queryFn: () =>
			api.integrations.slackConversations(integrationId as string, workspaceId, resolvedTypes),
		enabled: Boolean(integrationId),
		staleTime: FIVE_MINUTES,
	})
}

export function useSlackUsers(integrationId: string | undefined, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.slackUsers(integrationId ?? ''),
		queryFn: () => api.integrations.slackUsers(integrationId as string, workspaceId),
		enabled: Boolean(integrationId),
		staleTime: FIVE_MINUTES,
	})
}

/**
 * P3-K · Enumerate LinkedIn identities for a workspace. Every connected
 * identity — the human profile plus each admined page — is one Quick Add
 * button in the agent MCP panel. Returns [] when linkedin-unipile is not
 * connected.
 */
export function useLinkedInIdentities(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.linkedinIdentities(workspaceId),
		queryFn: () => api.integrations.linkedinIdentities(workspaceId),
		staleTime: FIVE_MINUTES,
	})
}

/** Folder watches on the workspace Drive connections, for the Drive detail page. */
export function useDriveWatches(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.driveWatches(workspaceId),
		queryFn: () => api.integrations.driveWatches(workspaceId),
	})
}

export function useStopDriveWatch(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (folderId: string) => api.integrations.stopDriveWatch(workspaceId, folderId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.driveWatches(workspaceId) })
		},
	})
}
