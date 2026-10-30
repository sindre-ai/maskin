import { capturePosthogEvent } from './posthog'

interface FileSavedProps {
	workspaceId: string
	fileId: string
	actorId: string
	actorType: 'human' | 'agent'
	fileType: string
	sizeBytes: number
	/** Set when a person accepted agent-proposed changes; every other save is typed. */
	acceptedChange?: {
		proposalId: string
		/** The session that made the proposal, when it came from one. */
		proposalSessionId: string | null
		acceptedCount: number
		/** How many of the accepted changes the person edited before accepting. */
		editedCount: number
	}
}

/**
 * A file's content changed through a save. Sent by the server after the new
 * bytes are stored and the row has committed, never from the browser. The
 * source is fixed here so no request body can set it: typed for an editor
 * save, accepted_change when a person accepted agent-proposed changes.
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
		source: p.acceptedChange ? 'accepted_change' : 'typed',
		...(p.acceptedChange
			? {
					proposal_id: p.acceptedChange.proposalId,
					proposal_session_id: p.acceptedChange.proposalSessionId,
					accepted_count: p.acceptedChange.acceptedCount,
					edited_count: p.acceptedChange.editedCount,
				}
			: {}),
	})
}
