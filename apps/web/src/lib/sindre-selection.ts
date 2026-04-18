/**
 * Composer-level selection state for the Sindre chat. An `agent` is single-
 * select — when set, the next send is routed to that agent as a one-shot
 * session instead of the persistent Sindre session. `objects` are multi-select
 * and attached as context to whichever target receives the send.
 *
 * Task 35 will wire a full reducer + chips UI on top of this type. Task 31
 * only needs the shape to route the send action.
 */

export interface SindreSelectionAgent {
	id: string
	name?: string | null
}

export interface SindreSelectionObject {
	id: string
	title?: string | null
	type?: string | null
}

export interface SindreSelection {
	agent: SindreSelectionAgent | null
	objects: SindreSelectionObject[]
}

export const EMPTY_SINDRE_SELECTION: SindreSelection = {
	agent: null,
	objects: [],
}

/**
 * Builds the action_prompt body for a one-shot session: the raw user message
 * followed by a compact context block when objects are attached. Kept as a
 * pure function so the send-wiring can be unit-tested without a live
 * container.
 */
export function buildOneShotActionPrompt(
	content: string,
	objects: SindreSelectionObject[],
): string {
	if (objects.length === 0) return content
	const block = objects
		.map((o) => {
			const label = o.title?.trim() || o.id
			const typeTag = o.type ? ` (${o.type})` : ''
			return `- ${label}${typeTag} — id: ${o.id}`
		})
		.join('\n')
	return `${content}\n\n---\nContext objects:\n${block}`
}
