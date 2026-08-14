/**
 * Composer-level selection state for the chat. An `agent` is single-
 * select — when set, the next send is routed to that agent as a one-shot
 * session instead of the persistent chat session. `objects` are multi-select
 * and attached as context to whichever target receives the send.
 * `notifications` are multi-select and seeded by the Pulse "Chat with agents"
 * action so the notification being discussed shows up as a chip and is
 * forwarded as first-class context on the next send.
 *
 * Task 35 layers a pure reducer + chips UI on top of this type; task 36's
 * slash picker dispatches into the same reducer so both entry points converge
 * on a single source of truth for the composer's selection.
 */

export interface ChatSelectionAgent {
	id: string
	name?: string | null
}

export interface ChatSelectionObject {
	id: string
	title?: string | null
	type?: string | null
}

export interface ChatSelectionNotification {
	id: string
	title?: string | null
}

export interface ChatSelectionFile {
	/** Server-side file id returned by POST /files after the binary upload. */
	fileId: string
	name: string
	sizeBytes: number
	mimeType?: string
}

export interface ChatSelection {
	agent: ChatSelectionAgent | null
	objects: ChatSelectionObject[]
	notifications: ChatSelectionNotification[]
	files: ChatSelectionFile[]
}

export const EMPTY_CHAT_SELECTION: ChatSelection = {
	agent: null,
	objects: [],
	notifications: [],
	files: [],
}

/**
 * Builds the action_prompt body for a one-shot session: the raw user message
 * followed by a compact context block when objects and/or notifications are
 * attached. Kept as a pure function so the send-wiring can be unit-tested
 * without a live container. Also used by the persistent chat send path to
 * inject notification context directly into the user turn, since the backend
 * currently forwards only `content` to the interactive container's stdin.
 */
export function buildOneShotActionPrompt(
	content: string,
	objects: ChatSelectionObject[],
	notifications: ChatSelectionNotification[] = [],
	files: ChatSelectionFile[] = [],
): string {
	if (objects.length === 0 && notifications.length === 0 && files.length === 0) return content
	const lines: string[] = [content, '', '---']
	if (objects.length > 0) {
		lines.push('Context objects:')
		for (const o of objects) {
			const label = o.title?.trim() || o.id
			const typeTag = o.type ? ` (${o.type})` : ''
			lines.push(`- ${label}${typeTag} — id: ${o.id}`)
		}
	}
	if (notifications.length > 0) {
		if (objects.length > 0) lines.push('')
		lines.push('Context notifications:')
		for (const n of notifications) {
			const label = n.title?.trim() || n.id
			lines.push(`- ${label} — id: ${n.id}`)
		}
	}
	if (files.length > 0) {
		if (objects.length > 0 || notifications.length > 0) lines.push('')
		lines.push('Attached files:')
		for (const f of files) {
			lines.push(`- ${f.name} — file_id: ${f.fileId}`)
		}
	}
	return lines.join('\n')
}

/**
 * Reducer actions for the chat composer selection. Agent is single-select,
 * so `add_agent` replaces whatever was there. Objects and notifications are
 * multi-select, deduped by `id`.
 */
export type ChatSelectionAction =
	| { type: 'add_agent'; agent: ChatSelectionAgent }
	| { type: 'remove_agent' }
	| { type: 'add_object'; object: ChatSelectionObject }
	| { type: 'remove_object'; id: string }
	| { type: 'add_notification'; notification: ChatSelectionNotification }
	| { type: 'remove_notification'; id: string }
	| { type: 'add_file'; file: ChatSelectionFile }
	| { type: 'remove_file'; fileId: string }
	| { type: 'clear_all' }

/**
 * Pure reducer for the composer's selection state. Drives the chips UI and
 * the send-routing branch in `<Chat>`.
 *
 * Invariants:
 * - Single-agent rule — `add_agent` replaces the current agent; there is at
 *   most one agent in the selection.
 * - Objects and notifications are deduplicated by `id` — re-adding an
 *   existing id is a no-op.
 * - No-op branches return the previous state reference so callers wrapping in
 *   `useReducer` can rely on referential equality for memoization and effect
 *   dependency arrays.
 */
export function chatSelectionReducer(
	state: ChatSelection,
	action: ChatSelectionAction,
): ChatSelection {
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
		case 'add_notification': {
			if (state.notifications.some((n) => n.id === action.notification.id)) return state
			return { ...state, notifications: [...state.notifications, action.notification] }
		}
		case 'remove_notification': {
			const next = state.notifications.filter((n) => n.id !== action.id)
			if (next.length === state.notifications.length) return state
			return { ...state, notifications: next }
		}
		case 'add_file': {
			if (state.files.some((f) => f.fileId === action.file.fileId)) return state
			return { ...state, files: [...state.files, action.file] }
		}
		case 'remove_file': {
			const next = state.files.filter((f) => f.fileId !== action.fileId)
			if (next.length === state.files.length) return state
			return { ...state, files: next }
		}
		case 'clear_all': {
			if (
				state.agent === null &&
				state.objects.length === 0 &&
				state.notifications.length === 0 &&
				state.files.length === 0
			) {
				return state
			}
			return EMPTY_CHAT_SELECTION
		}
	}
}
