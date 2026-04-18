/**
 * Composer-level selection state for the Sindre chat. An `agent` is single-
 * select — when set, the next send is routed to that agent as a one-shot
 * session instead of the persistent Sindre session. `objects` are multi-select
 * and attached as context to whichever target receives the send.
 *
 * Task 35 layers a pure reducer + chips UI on top of this type; task 36's
 * slash picker dispatches into the same reducer so both entry points converge
 * on a single source of truth for the composer's selection.
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

/**
 * Reducer actions for the Sindre composer selection. Agent is single-select,
 * so `add_agent` replaces whatever was there. Objects are multi-select,
 * deduped by `id`.
 */
export type SindreSelectionAction =
	| { type: 'add_agent'; agent: SindreSelectionAgent }
	| { type: 'remove_agent' }
	| { type: 'add_object'; object: SindreSelectionObject }
	| { type: 'remove_object'; id: string }
	| { type: 'clear_all' }

/**
 * Pure reducer for the composer's selection state. Drives the chips UI and
 * the send-routing branch in `<SindreChat>`.
 *
 * Invariants:
 * - Single-agent rule — `add_agent` replaces the current agent; there is at
 *   most one agent in the selection.
 * - Objects are deduplicated by `id` — re-adding an existing id is a no-op.
 * - No-op branches return the previous state reference so callers wrapping in
 *   `useReducer` can rely on referential equality for memoization and effect
 *   dependency arrays.
 */
export function sindreSelectionReducer(
	state: SindreSelection,
	action: SindreSelectionAction,
): SindreSelection {
	switch (action.type) {
		case 'add_agent': {
			const current = state.agent
			if (
				current !== null &&
				current.id === action.agent.id &&
				(current.name ?? null) === (action.agent.name ?? null)
			) {
				return state
			}
			return { ...state, agent: action.agent }
		}
		case 'remove_agent': {
			if (state.agent === null) return state
			return { ...state, agent: null }
		}
		case 'add_object': {
			if (state.objects.some((o) => o.id === action.object.id)) return state
			return { ...state, objects: [...state.objects, action.object] }
		}
		case 'remove_object': {
			const next = state.objects.filter((o) => o.id !== action.id)
			if (next.length === state.objects.length) return state
			return { ...state, objects: next }
		}
		case 'clear_all': {
			if (state.agent === null && state.objects.length === 0) return state
			return EMPTY_SINDRE_SELECTION
		}
	}
}
