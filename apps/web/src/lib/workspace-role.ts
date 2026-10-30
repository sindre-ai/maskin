import { ApiError } from './api'

/** Shown on every control a viewer cannot use, and when the server refuses a write anyway. */
export const VIEWER_READ_ONLY_MESSAGE = 'Viewers can read but not change this'

// The server's wording for a viewer's refused write (ViewerReadOnlyError in
// apps/dev/src/lib/workspace-auth.ts). It is a plain 403, so the text is the
// only thing that tells it apart from other forbidden answers.
const SERVER_VIEWER_REFUSAL = 'Viewers have read-only access to this workspace'

/** Whether a workspace role may change things. Unknown roles stay writable: the server decides. */
export function canWriteWithRole(role: string | null | undefined): boolean {
	return role !== 'viewer'
}

/** True when the error is the server refusing a write because the caller is a viewer. */
export function isViewerRefusal(error: unknown): boolean {
	return (
		error instanceof ApiError && error.status === 403 && error.message === SERVER_VIEWER_REFUSAL
	)
}
