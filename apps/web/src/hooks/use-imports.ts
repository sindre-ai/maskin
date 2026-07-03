import type { ImportMappingInput, ImportResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export function useImportPreview(workspaceId: string) {
	return useMutation({
		mutationFn: ({ id, mapping }: { id: string; mapping: ImportMappingInput }) =>
			api.imports.preview(id, mapping, workspaceId),
	})
}

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

// Workspace-scoped list of imports for the `/imports` index page. Pass `params`
// to filter by status or paginate; the backend returns the same shape regardless.
export function useImports(workspaceId: string, params?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.imports.list(workspaceId, params),
		queryFn: () => api.imports.list(workspaceId, params),
	})
}

// Per-row audit entries for an import. Powers the AC-U5 detail view —
// each entry carries `changedColumns` + `oldValues` / `newValues` so the
// page can render `old → new` per changed attribute.
export function useImportAuditRows(
	id: string | undefined,
	workspaceId: string,
	params?: Record<string, string>,
) {
	return useQuery({
		queryKey: queryKeys.imports.auditRows(id ?? '', params),
		queryFn: () => api.imports.listAuditRows(id as string, workspaceId, params),
		enabled: !!id,
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
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, mapping }: { id: string; mapping: ImportMappingInput }) =>
			api.imports.updateMapping(id, mapping, workspaceId),
		onSuccess: (data) => {
			// Update the cache directly so MappingStep sees fresh preview/mapping after re-parse
			queryClient.setQueryData(queryKeys.imports.detail(data.id), data)
		},
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
	const toastId = useRef<string | number | undefined>(undefined)
	const prevStatus = useRef<string | undefined>(undefined)

	const { data: importData } = useImport(activeImportId, workspaceId)

	useEffect(() => {
		if (!importData || !activeImportId) return

		const {
			status,
			totalRows,
			processedRows,
			successCount,
			errorCount,
			updatedCount,
			skippedCount,
			fileName,
		} = importData
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
				const parts: string[] = []
				if (successCount > 0) parts.push(`${successCount} created`)
				if (updatedCount > 0) parts.push(`${updatedCount} updated`)
				if (skippedCount > 0) parts.push(`${skippedCount} unchanged`)
				if (errorCount > 0) parts.push(`${errorCount} failed`)
				if (parts.length === 0) parts.push('no rows resolved')
				toast.success(`Import complete: ${parts.join(', ')}`)
			} else {
				toast.error(`Import failed: ${errorCount} errors`)
			}

			setActiveImportId(undefined)
		}

		prevStatus.current = status
	}, [importData, activeImportId])

	// Dismiss loading toast if component unmounts mid-import
	useEffect(() => {
		return () => {
			if (toastId.current) toast.dismiss(toastId.current)
		}
	}, [])

	const startTracking = useCallback((id: string | undefined) => {
		prevStatus.current = undefined
		setActiveImportId(id)
	}, [])

	return { startTracking }
}
