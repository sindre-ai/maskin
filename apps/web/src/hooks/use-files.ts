import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	type CreateFileInput,
	type FileDetail,
	type FileListItem,
	type FileTagMatch,
	type UpdateFileInput,
	api,
} from '../lib/api'
import { type LargeFileUpload, uploadLargeFile } from '../lib/large-file-upload'
import { fetchAllPages } from '../lib/pagination'
import { queryKeys } from '../lib/query-keys'

export function useFile(workspaceId: string, fileId: string | null) {
	return useQuery({
		queryKey: queryKeys.files.detail(workspaceId, fileId ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.files.get(workspaceId, fileId!),
		enabled: !!workspaceId && !!fileId,
	})
}

export function useFiles(workspaceId: string, params?: { q?: string; ids?: string[] }) {
	return useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'list', params],
		queryFn: () => api.files.list(workspaceId, params),
		// Skip the query when ids is explicitly empty — callers pass [] when an object has no
		// attachments yet, and we don't want to fetch all workspace files in that case.
		// Equivalent to: params?.ids === undefined || params.ids.length > 0
		enabled: !!workspaceId && !(params?.ids !== undefined && params.ids.length === 0),
	})
}

/**
 * Every file in the workspace, A→Z by name (the app's list default), optionally narrowed by a
 * name search. Pages through the endpoint so the sort is over the whole set, not one page.
 */
export function useAllFiles(
	workspaceId: string,
	q?: string,
	tagFilter?: { tags: string[]; match: FileTagMatch },
) {
	const tags = tagFilter?.tags ?? []
	const match = tagFilter?.match ?? 'all'
	return useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'all', q ?? '', tags.join(','), match],
		queryFn: async () => {
			const rows = await fetchAllPages<FileListItem>(({ limit, offset }) =>
				api.files.list(workspaceId, {
					q,
					limit,
					offset,
					...(tags.length > 0 ? { tags, tags_match: match } : {}),
				}),
			)
			return rows.sort(
				(a, b) =>
					a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
					a.id.localeCompare(b.id),
			)
		},
		enabled: !!workspaceId,
	})
}

/** The tags in use in the workspace with file counts, from the same endpoint the agent tool reads. */
export function useFileTags(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.files.tags(workspaceId),
		queryFn: () => api.files.tags(workspaceId),
		enabled: !!workspaceId,
	})
}

function primeFileCaches(queryClient: ReturnType<typeof useQueryClient>, file: FileDetail) {
	queryClient.setQueryData(queryKeys.files.detail(file.workspaceId, file.id), file)
	queryClient.invalidateQueries({ queryKey: queryKeys.files.all(file.workspaceId) })
}

export function useCreateFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateFileInput) => api.files.create(workspaceId, data),
		onSuccess: (file) => primeFileCaches(queryClient, file),
	})
}

export function useUpdateFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateFileInput }) =>
			api.files.update(workspaceId, id, data),
		onSuccess: (file) => primeFileCaches(queryClient, file),
	})
}

/**
 * Imperative upload helper for callers that need byte-level progress and
 * cancellation — e.g. the comment composer's attachment chips. Use the
 * `useCreateFile` mutation when you don't need progress.
 *
 * Takes either a base64 `CreateFileInput` (small files, one JSON request) or a
 * `{ file }` (large files, sent in parts straight to storage). `toUploadInput`
 * in lib/large-file-upload picks the right one for a picked File.
 */
export function useUploadFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return (
		data: CreateFileInput | LargeFileUpload,
		opts?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
	) =>
		('file' in data
			? uploadLargeFile(workspaceId, data.file, opts)
			: api.files.createWithProgress(workspaceId, data, opts)
		).then((file) => {
			primeFileCaches(queryClient, file)
			return file
		})
}
