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

type DesktopFileMovedProps = {
	workspaceId: string
	actorId: string
	/** to_computer: a workspace file put on the computer. to_maskin: a computer file saved. */
	direction: 'to_computer' | 'to_maskin'
	/** ok, or the category of what went wrong. Never a message, a name or a path. */
	outcome: string
	sizeBytes: number | null
}

/** Size buckets that keep the property low-cardinality; unknown when the size was never read. */
export function desktopFileSizeBucket(sizeBytes: number | null): string {
	if (sizeBytes == null) return 'unknown'
	const MB = 1024 * 1024
	if (sizeBytes < MB) return 'under_1mb'
	if (sizeBytes < 10 * MB) return '1_10mb'
	if (sizeBytes < 50 * MB) return '10_50mb'
	if (sizeBytes <= 100 * MB) return '50_100mb'
	return 'over_100mb'
}

/**
 * A file moved between a workspace and an agent's computer, in either direction, or the
 * attempt failed. Sent by the server after the move has settled. Carries no file name or path.
 */
export async function trackDesktopFileMoved(p: DesktopFileMovedProps): Promise<void> {
	await capturePosthogEvent('desktop_file_moved', p.actorId, {
		workspace_id: p.workspaceId,
		direction: p.direction,
		outcome: p.outcome,
		size_bucket: desktopFileSizeBucket(p.sizeBytes),
	})
}
