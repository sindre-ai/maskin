import { capturePosthogEvent } from './posthog'

interface FileSavedProps {
	workspaceId: string
	fileId: string
	actorId: string
	actorType: 'human' | 'agent'
	fileType: string
	sizeBytes: number
}

/**
 * A file's content changed through a save. Sent by the server after the new
 * bytes are stored and the row has committed, never from the browser. The
 * source is fixed here so no request body can set it; the review bet adds its
 * own value from its accept action.
 *
 * File saves are their own series and are never folded into the object edit
 * baseline. Autosave fires after every pause in typing, so raw counts are for
 * debugging only; the read counts distinct file, person and day for humans.
 */
export async function trackFileSaved(p: FileSavedProps): Promise<void> {
	await capturePosthogEvent('file_saved', p.actorId, {
		workspace_id: p.workspaceId,
		file_id: p.fileId,
		actor_type: p.actorType,
		file_type: p.fileType,
		size_bytes: p.sizeBytes,
		source: 'typed',
	})
}
