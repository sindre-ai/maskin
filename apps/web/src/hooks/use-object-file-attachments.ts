import { useCreateFile, useUploadFile } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import type { RelationshipCreatedSource } from '@/lib/analytics'
import { api } from '@/lib/api'
import { readFileAsBase64 } from '@/lib/file-utils'
import { assertUploadable, isLargeFile } from '@/lib/large-file-upload'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

/** The semantic edge type a file attachment writes. */
export const ATTACHED_REL_TYPE = 'attached'

/**
 * Upload files and attach them to an object in one step — create the `files`
 * row, then the `attached` edge back to the object. Shared by the properties
 * drawer's FILES section and the Related tab's "+ Upload a file" affordance so
 * both write the same pair of records. Callers may pass `source` on `upload()`
 * to tag the emitted `relationship_created` event for PostHog attribution
 * (D11 uses this to isolate CTA-driven uptake from other attach paths).
 */
export function useObjectFileAttachments({
	workspaceId,
	objectId,
	objectType,
}: {
	workspaceId: string
	objectId: string
	objectType: string
}) {
	const createFile = useCreateFile(workspaceId)
	const uploadFile = useUploadFile(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, objectId)
	const [isUploading, setIsUploading] = useState(false)

	const upload = useCallback(
		async (incoming: File[], options?: { source?: RelationshipCreatedSource }) => {
			setIsUploading(true)
			const failed: string[] = []
			try {
				for (const file of incoming) {
					// Each file is isolated: one failure must not silently strand the
					// files behind it in the selection, which is what a single try/catch
					// around the whole loop did.
					let createdId: string | null = null
					try {
						assertUploadable(file)
						// Past the JSON path's size the bytes go to storage in parts instead.
						const created = isLargeFile(file)
							? await uploadFile({ file })
							: await createFile.mutateAsync({
									name: file.name,
									mime_type: file.type || 'application/octet-stream',
									content: await readFileAsBase64(file),
									encoding: 'base64',
								})
						createdId = created.id
						await createRelationship.mutateAsync({
							source_type: objectType,
							source_id: objectId,
							target_type: 'file',
							target_id: created.id,
							type: ATTACHED_REL_TYPE,
							source: options?.source,
						})
						toast.success(`Uploaded ${file.name}`)
					} catch {
						failed.push(file.name)
						// The row exists but nothing points at it — an upload the user
						// was told failed would otherwise sit in the workspace, attached
						// to nothing and counting against storage. Compensate directly:
						// there is no cache to reconcile for a file that never appeared.
						if (createdId) await api.files.delete(workspaceId, createdId).catch(() => {})
					}
				}
				if (failed.length === 1) toast.error(`Failed to upload ${failed[0]}`)
				else if (failed.length > 1)
					toast.error(`Failed to upload ${failed.length} files: ${failed.join(', ')}`)
			} finally {
				setIsUploading(false)
			}
		},
		[createFile, uploadFile, createRelationship, objectId, objectType, workspaceId],
	)

	return { upload, isUploading }
}
