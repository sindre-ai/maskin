import type { WorkspaceResponse } from './api'

export const PINNED_FILES_SETTINGS_KEY = 'pinned_files'

// Pinned entries are references to live file objects — never snapshots. The
// sidebar resolves each id against the current file row, so T4's in-place byte
// swap shows through reopen-after-regen and a deleted file simply stops
// appearing. Any malformed stored value degrades to an empty list.
export function getPinnedFileIds(
	workspace: Pick<WorkspaceResponse, 'settings'> | null | undefined,
): string[] {
	const raw = workspace?.settings?.[PINNED_FILES_SETTINGS_KEY]
	if (!Array.isArray(raw)) return []
	return raw.filter((id): id is string => typeof id === 'string')
}

export function togglePinnedFile(
	workspace: Pick<WorkspaceResponse, 'settings'> | null | undefined,
	fileId: string,
): string[] {
	const ids = getPinnedFileIds(workspace)
	return ids.includes(fileId) ? ids.filter((id) => id !== fileId) : [...ids, fileId]
}

export function isPinned(
	workspace: Pick<WorkspaceResponse, 'settings'> | null | undefined,
	fileId: string,
): boolean {
	return getPinnedFileIds(workspace).includes(fileId)
}
