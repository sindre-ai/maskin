import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useInstalledPackages(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.installedPackages.list(workspaceId),
		queryFn: () => api.installedPackages.list(workspaceId),
		enabled: Boolean(workspaceId),
	})
}

export function useInstallPackage(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ packageId }: { packageId: string }) =>
			api.installedPackages.install(workspaceId, packageId),
		onSuccess: () => {
			toast.success('Package installed')
			queryClient.invalidateQueries({ queryKey: queryKeys.installedPackages.all(workspaceId) })
		},
	})
}

export function useForkInstalledPackage(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ installedPackageId }: { installedPackageId: string }) =>
			api.installedPackages.fork(workspaceId, installedPackageId),
		onSuccess: () => {
			toast.success('Package forked')
			queryClient.invalidateQueries({ queryKey: queryKeys.installedPackages.all(workspaceId) })
		},
	})
}
