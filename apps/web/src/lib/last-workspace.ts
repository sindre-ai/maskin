const LAST_WORKSPACE_KEY = 'maskin-last-workspace'

// Storage can be missing or throw (Safari private mode, policy-disabled storage),
// so both helpers degrade to "no remembered workspace" instead of throwing.
export function getLastWorkspaceId(): string | null {
	try {
		return localStorage.getItem(LAST_WORKSPACE_KEY)
	} catch {
		return null
	}
}

export function setLastWorkspaceId(workspaceId: string) {
	try {
		localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId)
	} catch {
		// Nothing to persist to — the next visit falls back to the first workspace.
	}
}
