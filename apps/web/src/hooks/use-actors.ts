import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { type CreateActorInput, type RunAgentInput, type UpdateActorInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useActors(workspaceId?: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.actors.all(workspaceId),
		queryFn: () => api.actors.list(workspaceId),
		enabled: options?.enabled,
	})
}

export function useActor(id: string) {
	return useQuery({
		queryKey: queryKeys.actors.detail(id),
		queryFn: () => api.actors.get(id),
		enabled: !!id,
	})
}

/** Derives agent from the workspace actors list — returns undefined for non-existent IDs (create mode). */
export function useAgent(id: string, workspaceId: string) {
	const { data: actors, ...rest } = useActors(workspaceId)
	return {
		...rest,
		data: actors?.find((a) => a.id === id),
	}
}

export function useCreateActor(workspaceId?: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateActorInput) => api.actors.create(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
	})
}

export function useUpdateActor(workspaceId?: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateActorInput }) =>
			api.actors.update(id, data, workspaceId),
		onSuccess: (_result, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
	})
}

export function useDeleteActor(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.actors.delete(id, workspaceId),
		onSuccess: () => {
			toast.success('Agent deleted')
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
		onError: () => {
			toast.error('Failed to delete agent')
		},
	})
}

// Fetches avatar bytes and returns a data: URI for direct <img src> use.
// Bearer-token auth means an <img src="/api/..."> can't authenticate itself,
// so this mirrors the file-viewer pattern: fetch base64 via the authenticated
// client, decode client-side. Keyed on storageKey so a re-upload (new key)
// refetches instead of serving a stale cached image.
export function useActorAvatarUrl(actorId: string, avatarStorageKey?: string | null) {
	return useQuery({
		queryKey: queryKeys.actors.avatar(actorId, avatarStorageKey),
		queryFn: async () => {
			const { content, mime_type } = await api.actors.getAvatar(actorId)
			return `data:${mime_type};base64,${content}`
		},
		enabled: !!actorId && !!avatarStorageKey,
		staleTime: Number.POSITIVE_INFINITY,
	})
}

export function useUploadAvatar(actorId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (file: File) => api.actors.uploadAvatar(actorId, file),
		onSuccess: (updated) => {
			queryClient.setQueryData(queryKeys.actors.detail(actorId), updated)
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(actorId) })
		},
	})
}

export function useResetActor(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.actors.reset(id, workspaceId),
		onSuccess: (_result, id) => {
			toast.success('Agent reset to default')
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
		onError: () => {
			toast.error('Failed to reset agent')
		},
	})
}

function invalidateAgentControls(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
	actorId: string,
) {
	queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(actorId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.sessions.byActor(workspaceId, actorId) })
	queryClient.invalidateQueries({ queryKey: queryKeys.sessions.byActorAll(workspaceId, actorId) })
}

export function useAgentPause(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.actors.pause(id, workspaceId),
		onSuccess: (_result, id) => {
			invalidateAgentControls(queryClient, workspaceId, id)
		},
		onError: () => {
			toast.error('Failed to pause agent')
		},
	})
}

export function useAgentRun(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, body }: { id: string; body?: RunAgentInput }) =>
			api.actors.run(id, workspaceId, body),
		onSuccess: (_result, { id }) => {
			invalidateAgentControls(queryClient, workspaceId, id)
		},
		onError: () => {
			toast.error('Failed to run agent')
		},
	})
}
