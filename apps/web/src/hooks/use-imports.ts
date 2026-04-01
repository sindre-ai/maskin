import type { ImportMappingInput, ImportResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export function useImport(id: string | undefined, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.imports.detail(id ?? ''),
		queryFn: () => api.imports.get(id as string, workspaceId),
		enabled: !!id,
		refetchInterval: (query) => {
			const data = query.state.data as ImportResponse | undefined
			// Poll while importing
			if (data?.status === 'importing') return 2000
			return false
		},
	})
}

export function useCreateImport(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (file: File) => api.imports.create(workspaceId, file),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.all(workspaceId) })
		},
	})
}

export function useUpdateImportMapping(workspaceId: string) {
	return useMutation({
		mutationFn: ({ id, mapping }: { id: string; mapping: ImportMappingInput }) =>
			api.imports.updateMapping(id, mapping, workspaceId),
	})
}

export function useConfirmImport(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.imports.confirm(id, workspaceId),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.detail(data.id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		},
	})
}

export function useImportToast(workspaceId: string) {
	const [activeImportId, setActiveImportId] = useState<string | undefined>()
	const toastId = useRef<string | number | undefined>()
	const prevStatus = useRef<string | undefined>()

	const { data: importData } = useImport(activeImportId, workspaceId)

	useEffect(() => {
		if (!importData || !activeImportId) return

		const { status, totalRows, processedRows, successCount, errorCount, fileName } = importData
		const progress = totalRows ? Math.round((processedRows / totalRows) * 100) : 0

		if (status === 'importing') {
			const message = `Importing ${fileName}... ${progress}%`
			if (toastId.current) {
				toast.loading(message, { id: toastId.current })
			} else {
				toastId.current = toast.loading(message)
			}
		}

		if ((status === 'completed' || status === 'failed') && prevStatus.current !== status) {
			// Dismiss the loading toast
			if (toastId.current) {
				toast.dismiss(toastId.current)
				toastId.current = undefined
			}

			if (status === 'completed') {
				const parts = [`${successCount} objects created`]
				if (errorCount > 0) parts.push(`${errorCount} failed`)
				toast.success(`Import complete: ${parts.join(', ')}`)
			} else {
				toast.error(`Import failed: ${errorCount} errors`)
			}

			setActiveImportId(undefined)
		}

		prevStatus.current = status
	}, [importData, activeImportId])

	return { startTracking: setActiveImportId }
}
