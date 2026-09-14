/**
 * Composer-level selection state for the chat. `agents` is the composer's
 * multi-mention list — every `@` insertion appends the picked actor id in
 * order, deduplicated. When the message is sent the array becomes the POST
 * body's `metadata.mentions`, which the backend fast-path auto-joins as
 * conversation participants (`conversations.ts`) and hands the responder the
 * `wasMentioned=true` short-circuit (`conversation-responder.ts`). `objects`
 * and `notifications` are multi-select context chips; `files` are uploaded
 * attachments the composer waits on before enabling send.
 *
 * The single-select agent bit that previously lived here (a routing override
 * for the "next send") is retired in favour of the mentions list — the first
 * mention takes the send-target role in surfaces that need one (Brief drawer,
 * new-chat page) so both entry points converge on one field.
 */

import { MESSAGE_MAX_MENTIONS } from '@maskin/shared'

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
	/**
	 * Mentioned actor ids in insertion order. Matches
	 * `messageMetadataSchema.mentions` on the wire — the array is capped at
	 * `MESSAGE_MAX_MENTIONS` here so the send-path never has to trim.
	 */
	agents: string[]
	/**
	 * Display names for the ids in `agents`, keyed by id. Filled at insertion
	 * time (the picker knows the name of what it just picked) so chips can
	 * render a label without an extra network round trip; the wire payload
	 * still carries only the ids, keeping the source of truth on the actors
	 * list.
	 */
	agentNames: Record<string, string>
	objects: ChatSelectionObject[]
	notifications: ChatSelectionNotification[]
	files: ChatSelectionFile[]
}

export const EMPTY_CHAT_SELECTION: ChatSelection = {
	agents: [],
	agentNames: {},
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
 * Reducer actions for the chat composer selection. `add_agent` appends to the
 * mentions list (deduped by id, capped at `MESSAGE_MAX_MENTIONS`); `remove_agent`
 * strips the given id. Objects and notifications are multi-select, deduped by
 * `id`.
 */
export type ChatSelectionAction =
	| { type: 'add_agent'; agent: ChatSelectionAgent }
	| { type: 'remove_agent'; id: string }
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
 * - Multi-mention rule — `add_agent` appends to `agents` (deduped by id, capped
 *   at `MESSAGE_MAX_MENTIONS`); an already-present id is a no-op.
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
			if (state.agents.includes(action.agent.id)) {
				// Refresh the cached label if the picker learned a new name for the
				// same id, but keep the array reference so a re-pick with the same
				// name is a true no-op.
				const nextName = action.agent.name?.trim() ?? ''
				const prevName = state.agentNames[action.agent.id] ?? ''
				if (nextName.length === 0 || nextName === prevName) return state
				return {
					...state,
					agentNames: { ...state.agentNames, [action.agent.id]: nextName },
				}
			}
			if (state.agents.length >= MESSAGE_MAX_MENTIONS) return state
			const name = action.agent.name?.trim() ?? ''
			return {
				...state,
				agents: [...state.agents, action.agent.id],
				agentNames: name.length > 0
					? { ...state.agentNames, [action.agent.id]: name }
					: state.agentNames,
			}
		}
		case 'remove_agent': {
			if (!state.agents.includes(action.id)) return state
			const nextAgents = state.agents.filter((id) => id !== action.id)
			const { [action.id]: _dropped, ...nextNames } = state.agentNames
			return { ...state, agents: nextAgents, agentNames: nextNames }
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
				state.agents.length === 0 &&
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

/**
 * How many objects "Ask an agent" may hand to a new chat in one go.
 *
 * Bounded by the objects list endpoint, not by taste: `objectQuerySchema`
 * caps `limit` at 100, so ids past the hundredth could not be resolved into
 * chips however many the URL carried — they would simply not arrive, with
 * nothing on screen to say so. The selection is trimmed to this at the
 * source and the trim is reported, so the count in the chat is the count the
 * user was told about.
 */
export const MAX_CHAT_OBJECT_REFERENCES = 100
