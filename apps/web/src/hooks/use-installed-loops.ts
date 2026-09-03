import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useInstalledLoops(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.installedLoops.list(workspaceId),
		queryFn: () => api.installedLoops.list(workspaceId),
		enabled: Boolean(workspaceId),
	})
}

export function useInstallLoop(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ loopId, source }: { loopId: string; source?: 'detail' }) =>
			api.installedLoops.install(workspaceId, loopId, source),
		onSuccess: () => {
			toast.success('Loop installed')
			queryClient.invalidateQueries({ queryKey: queryKeys.installedLoops.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			// Install creates an `objects` row (type: 'loop') for the installed bundle.
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		},
	})
}

export function useForkInstalledLoop(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ installedLoopId }: { installedLoopId: string }) =>
			api.installedLoops.fork(workspaceId, installedLoopId),
		onSuccess: () => {
			toast.success('Loop forked')
			queryClient.invalidateQueries({ queryKey: queryKeys.installedLoops.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

export function useUninstallLoop(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			installedLoopId,
			keepProvisionedItems,
		}: {
			installedLoopId: string
			keepProvisionedItems: boolean
		}) => api.installedLoops.uninstall(workspaceId, installedLoopId, keepProvisionedItems),
		onSuccess: () => {
			toast.success('Loop removed')
			queryClient.invalidateQueries({ queryKey: queryKeys.installedLoops.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}
