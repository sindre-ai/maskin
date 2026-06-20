const PREFIX = 'maskin-composer-draft'

function key(workspaceId: string, conversationId: string): string {
	return `${PREFIX}:${workspaceId}:${conversationId}`
}

export function getComposerDraft(workspaceId: string, conversationId: string): string {
	try {
		return localStorage.getItem(key(workspaceId, conversationId)) ?? ''
	} catch {
		return ''
	}
}

export function setComposerDraft(workspaceId: string, conversationId: string, value: string): void {
	try {
		if (value.length === 0) {
			localStorage.removeItem(key(workspaceId, conversationId))
			return
		}
		localStorage.setItem(key(workspaceId, conversationId), value)
	} catch {
		// Best-effort: localStorage can throw in private mode or when over quota.
		// Drafts are convenience, not durability — swallow and move on.
	}
}

export function clearComposerDraft(workspaceId: string, conversationId: string): void {
	try {
		localStorage.removeItem(key(workspaceId, conversationId))
	} catch {
		// See setComposerDraft.
	}
}
