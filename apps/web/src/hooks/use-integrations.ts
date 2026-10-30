import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
	type AgentGrantAccess,
	type CustomMcpServerSpec,
	type DefaultAgentAccess,
	api,
} from '../lib/api'
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
			// Workspace-relative path to land on once the connect finishes — the chat
			// that showed the Connect card. Absent means Settings → Integrations. The
			// backend only honours a plain path inside this workspace.
			returnTo?: string
			// Symbolic key of the page the flow started from, so a cancel on the
			// consent screen lands back there. Only the backend's known keys work.
			origin?: string
		}) => {
			const body =
				input.apiKey ||
				input.receiveSubdomain ||
				input.installNewOrg ||
				input.returnTo ||
				input.origin
					? {
							...(input.apiKey ? { api_key: input.apiKey } : {}),
							...(input.receiveSubdomain ? { receive_subdomain: input.receiveSubdomain } : {}),
							...(input.installNewOrg ? { install_new_org: true } : {}),
							...(input.returnTo ? { return_to: input.returnTo } : {}),
							...(input.origin ? { origin: input.origin } : {}),
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
export function useLinkableGithubInstallations(
	workspaceId: string,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.integrations.githubLinkable(workspaceId),
		queryFn: () => api.integrations.githubLinkable(workspaceId),
		enabled: options?.enabled ?? true,
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

/** Bulk disconnect of one human's Google rows, from the Drive disable modal.
 *  No toast: the detail page shows its own inline callout on success. */
export function useDisconnectGoogle(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: { email: string; scope: 'drive' | 'drive-meet' | 'google' }) =>
			api.integrations.disconnectGoogle(workspaceId, input),
		onSuccess: () => {
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

/** Keychain: paste an API key. The secret goes up once and is never kept in the cache. */
export function useCreateByoApiKey(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: { displayName: string; rawSecret: string }) =>
			api.integrations.createByoApiKey(workspaceId, input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/** Keychain: add a username and password. Both go up once and are never kept in the cache. */
export function useCreateByoLogin(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: {
			displayName: string
			username: string
			password: string
			email?: string
		}) => api.integrations.createByoLogin(workspaceId, input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/**
 * Keychain: rename a saved key or login, replace its secret, or both. The dialog shows the failure
 * inline (a taken name has a message a person can act on), so the global error toast is switched off.
 */
export function useUpdateCredential(workspaceId: string, integrationId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: { handlesOwnErrors: true },
		mutationFn: (body: {
			displayName?: string
			rawSecret?: string
			username?: string
			password?: string
			email?: string
		}) => api.integrations.updateCredential(integrationId, workspaceId, body),
		onSuccess: () => {
			toast.success('Credential updated')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/**
 * Keychain: remove a saved key or login at any time. The secret is destroyed on the server,
 * so the credential drops out of the list. The page shows the failure inline in its dialog,
 * so the global error toast is switched off.
 */
export function useRemoveCredential(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: { handlesOwnErrors: true },
		mutationFn: (integrationId: string) => api.integrations.remove(integrationId, workspaceId),
		onSuccess: () => {
			toast.success('Credential removed')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/**
 * Agent access: the three changes the Integrations page makes to who may use an
 * integration. Each refetches the list, which carries `defaultAgentAccess` and
 * `agentGrants` per integration. The audit trail and SSE event are written server-side.
 */
function useGrantMutation<V>(
	workspaceId: string,
	mutationFn: (variables: V) => Promise<unknown>,
	successMessage: string,
) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn,
		onSuccess: () => {
			toast.success(successMessage)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/** What one agent can use. Refreshes with the integration list, so it never lags a change. */
export function useAgentAccess(workspaceId: string, actorId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.agentAccess(workspaceId, actorId),
		queryFn: () => api.actors.access(actorId, workspaceId),
	})
}

export function useSetAgentGrant(workspaceId: string, integrationId: string) {
	return useGrantMutation(
		workspaceId,
		(v: { actorId: string; access: AgentGrantAccess }) =>
			api.integrations.setGrant(integrationId, workspaceId, v.actorId, v.access),
		'Agent access updated',
	)
}

export function useRemoveAgentGrant(workspaceId: string, integrationId: string) {
	return useGrantMutation(
		workspaceId,
		(actorId: string) => api.integrations.removeGrant(integrationId, workspaceId, actorId),
		'Agent access removed',
	)
}

export function useSetDefaultAgentAccess(workspaceId: string, integrationId: string) {
	return useGrantMutation(
		workspaceId,
		(defaultAgentAccess: DefaultAgentAccess) =>
			api.integrations.setDefaultAccess(integrationId, workspaceId, defaultAgentAccess),
		'Default access updated',
	)
}

/** A custom MCP server's definition, secrets masked. Fetched when its edit form opens. */
export function useCustomMcpServer(workspaceId: string, id: string | null) {
	return useQuery({
		queryKey: [...queryKeys.integrations.all(workspaceId), 'custom-mcp', id] as const,
		queryFn: () => api.customMcpServers.get(id as string, workspaceId),
		enabled: !!workspaceId && !!id,
		// A secret is never kept around: read it fresh each time the form opens.
		gcTime: 0,
	})
}

/** Add a custom MCP server. It reaches no agent until it is granted. */
export function useCreateCustomMcpServer(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: { handlesOwnErrors: true },
		mutationFn: (input: { name: string; server: CustomMcpServerSpec }) =>
			api.customMcpServers.create(workspaceId, input),
		onSuccess: () => {
			toast.success('Tool server added')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

export function useUpdateCustomMcpServer(workspaceId: string, id: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: { handlesOwnErrors: true },
		mutationFn: (input: { name: string; server: CustomMcpServerSpec }) =>
			api.customMcpServers.update(id, workspaceId, input),
		onSuccess: () => {
			toast.success('Tool server saved')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

/** Remove a custom MCP server: it drops out of every agent's next session. */
export function useRemoveCustomMcpServer(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.integrations.disconnect(id, workspaceId),
		onSuccess: () => {
			toast.success('Tool server removed')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}
