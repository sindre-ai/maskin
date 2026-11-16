import { AsyncLocalStorage } from 'node:async_hooks'
import type { AppliedRename } from './alias-layer.js'

// The old spellings in a call are rewritten inside the input schema, before the handler runs, and
// the handler only sees the rewritten arguments. This carries the renames from the schema step to
// the response step of the same call, so the reply can tell the agent which names to use next time.
//
// enterWith, not run: the schema step is inside the SDK, so there is no callback to wrap. A request
// is handled in its own async chain, so the value does not reach another request.
const pending = new AsyncLocalStorage<{ tool: string; renames: AppliedRename[] } | undefined>()

/** Called from the schema step with the renames it applied. An empty list clears any earlier value. */
export function stashRenames(tool: string, renames: AppliedRename[]): void {
	pending.enterWith(renames.length > 0 ? { tool, renames } : undefined)
}

/** Reads the renames stashed for this call, once. Empty when the call used no old name. */
export function takeRenames(tool: string): AppliedRename[] {
	const stashed = pending.getStore()
	if (!stashed) return []
	pending.enterWith(undefined)
	return stashed.tool === tool ? stashed.renames : []
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf('.') + 1)
}

export function renameNotice(renames: readonly AppliedRename[]): string {
	const parts = renames.map((r) => `"${lastSegment(r.old)}" is now "${lastSegment(r.new)}"`)
	return `Note: this call used an old parameter name and it was accepted: ${parts.join('; ')}. Use the current name next time.`
}

/** Adds the notice as a last text item. A response without a content list is returned as it is. */
export function withRenameNotice<T>(response: T, renames: readonly AppliedRename[]): T {
	if (renames.length === 0) return response
	const content = (response as { content?: unknown } | undefined)?.content
	if (!Array.isArray(content)) return response
	return {
		...response,
		content: [...content, { type: 'text', text: renameNotice(renames) }],
	}
}
