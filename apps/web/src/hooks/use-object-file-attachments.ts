import { useCreateFile } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import { readFileAsBase64 } from '@/lib/file-utils'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

/** The semantic edge type a file attachment writes. */
export const ATTACHED_REL_TYPE = 'attached'

/**
 * Upload files and attach them to an object in one step — create the `files`
 * row, then the `attached` edge back to the object. Shared by the properties
 * drawer's FILES section and the Related tab's "+ Upload a file" affordance so
 * both write the same pair of records.
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
	const createRelationship = useCreateRelationship(workspaceId, objectId)
	const [isUploading, setIsUploading] = useState(false)

	const upload = useCallback(
		async (incoming: File[]) => {
			setIsUploading(true)
			try {
				for (const file of incoming) {
					const content = await readFileAsBase64(file)
					const created = await createFile.mutateAsync({
						name: file.name,
						mime_type: file.type || 'application/octet-stream',
						content,
						encoding: 'base64',
					})
					await createRelationship.mutateAsync({
						source_type: objectType,
						source_id: objectId,
						target_type: 'file',
						target_id: created.id,
						type: ATTACHED_REL_TYPE,
					})
					toast.success(`Uploaded ${file.name}`)
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to upload file')
			} finally {
				setIsUploading(false)
			}
		},
		[createFile, createRelationship, objectId, objectType],
	)

	return { upload, isUploading }
}
