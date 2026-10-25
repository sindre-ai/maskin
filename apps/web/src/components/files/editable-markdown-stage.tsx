import { useFeatureFlag } from '@/hooks/use-feature-flag'
import {
	FileConflictError,
	FileRetryableError,
	type FileSaveClient,
} from '@/hooks/use-markdown-file-save'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { ApiError, type FileDetail, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { decodeBase64Utf8 } from '@/lib/file-utils'
import { queryKeys } from '@/lib/query-keys'
import { isMarkdownFile } from '@maskin/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { MarkdownFileEditor } from './markdown-file-editor'

function fileText(file: FileDetail): string {
	return file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
}

/**
 * The one read of the rich-markdown-editor flag for the file viewer. Flag on:
 * any file the shared markdown helper accepts (a .md file with a generic type
 * included) opens in the editor. Flag off: the viewer is exactly what shipped.
 */
export function useEditableMarkdown(file: FileDetail | undefined): boolean {
	const enabled = useFeatureFlag('rich-markdown-editor')
	return enabled && file !== undefined && isMarkdownFile(file)
}

export function EditableMarkdownStage({ file }: { file: FileDetail }) {
	const client = useFileSaveClient(file)
	const { data: members } = useWorkspaceMembers(file.workspaceId)
	// Viewers count as members on file routes, so the API would let them edit;
	// the UI must not offer it. Until the role is known, show the read view.
	const actorId = getStoredActor()?.id
	const role = members?.find((m) => m.actorId === actorId)?.role
	const hash = file.contentHash ?? null
	const canEdit = hash !== null && role !== undefined && role !== 'viewer'
	return (
		<div className="h-full w-full overflow-auto">
			<div className="mx-auto max-w-[740px] px-6 py-8">
				<MarkdownFileEditor
					fileId={file.id}
					text={fileText(file)}
					hash={hash ?? ''}
					client={client}
					canEdit={canEdit}
				/>
			</div>
		</div>
	)
}

/** The editor's save and reload calls for one file, on the shared files API. */
function useFileSaveClient(file: FileDetail): FileSaveClient {
	const queryClient = useQueryClient()
	const { workspaceId, id } = file
	return useMemo<FileSaveClient>(
		() => ({
			async save(text, ifMatch) {
				try {
					const updated = await api.files.update(workspaceId, id, {
						content: text,
						encoding: 'utf8',
						if_match: ifMatch,
					})
					queryClient.setQueryData(queryKeys.files.detail(workspaceId, id), updated)
					return { hash: requireContentHash(updated) }
				} catch (err) {
					if (err instanceof ApiError && err.status === 409) throw new FileConflictError()
					if (err instanceof ApiError && err.status === 503) throw new FileRetryableError()
					throw err
				}
			},
			async fetchLatest() {
				const latest = await api.files.get(workspaceId, id)
				return { text: fileText(latest), hash: requireContentHash(latest) }
			},
		}),
		[queryClient, workspaceId, id],
	)
}

function requireContentHash(file: FileDetail): string {
	if (!file.contentHash) throw new Error('The file came back without a content hash')
	return file.contentHash
}
