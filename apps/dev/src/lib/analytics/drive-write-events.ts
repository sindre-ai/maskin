import { type PosthogEventProps, capturePosthogEvent } from './posthog'

/**
 * One event per google_drive__write_file call. Carries the write path and the
 * target type only, never file names or content.
 */
export async function trackDriveFileWritten(p: {
	workspaceId: string
	actorId: string
	mimeType: string
	path: 'multipart' | 'resumable' | 'doc' | 'sheet'
}): Promise<void> {
	await capturePosthogEvent('drive_file_written', p.actorId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		mime_type: p.mimeType,
		path: p.path,
	} satisfies PosthogEventProps)
}

/** One event per google_drive__comment_on_document call. */
export async function trackDriveCommentCreated(p: {
	workspaceId: string
	actorId: string
	anchor: 'none' | 'doc' | 'sheet'
}): Promise<void> {
	await capturePosthogEvent('drive_comment_created', p.actorId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		anchor: p.anchor,
	} satisfies PosthogEventProps)
}
