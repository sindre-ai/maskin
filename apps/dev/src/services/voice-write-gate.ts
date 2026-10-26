import { randomUUID } from 'node:crypto'
import { logger } from '../lib/logger'

/**
 * The yes-before-a-write rule for a live voice call, enforced on the server.
 *
 * Telling the model to ask first is not a guard: it can skip the question or
 * take its own words for a yes. So a risky tool (see isRiskyTool: anything that
 * sends outside the workspace, starts work, deletes, or touches access) is held,
 * and it only runs when two things both happen: the model repeats the same call
 * with the id of the hold, and the person's next spoken line after the hold,
 * heard by our own socket to the Realtime call, is a clear yes.
 *
 * Ordinary changes inside the workspace (a comment, a status, a new task) run at
 * once. They are recorded in the events log and can be changed back, and making
 * the person confirm each one made a call too slow to use.
 */

export const VOICE_CONFIRM_TTL_MS = 60_000
/** How long a repeated call waits for the person's line when the model is quicker than the transcription. */
export const VOICE_CONFIRM_WAIT_MS = 3_000
/** The argument the model adds to repeat a held call. Removed before the tool runs. */
export const VOICE_CONFIRM_ARG = 'confirmation_id'

/** Words and phrases a yes can open with. */
const YES_OPENERS = [
	'yes',
	'yeah',
	'yep',
	'yup',
	'ja',
	'jep',
	'sure',
	'ok',
	'okay',
	'please',
	'confirm',
	'confirmed',
	'correct',
	'absolutely',
	'definitely',
	'exactly',
	'agreed',
	'perfect',
	'great',
	'alright',
	'fine',
	'approve',
	'approved',
	'i approve',
	'i agree',
	'sounds good',
	'sounds great',
	'that works',
	'that is right',
	'thats right',
	'that is correct',
	'thats correct',
	'do it',
	'do that',
	'lets do it',
	'lets do that',
	'lets go',
	'go ahead',
	'go for it',
	'send it',
	'send that',
]
const YES_START = new RegExp(`^(?:${YES_OPENERS.join('|')})(?:\\s|$)`)
/** Any of these anywhere in the line makes it not a yes: it is a no, a condition or a change of mind. */
const NO_WORDS = new Set([
	'no',
	'nope',
	'not',
	'never',
	'nothing',
	'wait',
	'hold',
	'stop',
	'cancel',
	'but',
	'however',
	'actually',
	'instead',
	'except',
	'only',
	'skip',
	'later',
	'change',
	'edit',
	'rather',
	'without',
	'dont',
	'cant',
	'wont',
	'shouldnt',
	'isnt',
	'arent',
	'wasnt',
	'nej',
])
const MAX_YES_WORDS = 8
/**
 * Every word of a yes must be an approval word or plain filler. Opening with "sure" or
 * "please" is not enough: "sure, what does it say" and "please read it to me first" are
 * requests, not approvals, and on a held send or delete they must not count. A line with
 * any other word is not a yes; the person is asked again.
 */
const YES_WORDS = new Set([
	...YES_OPENERS.flatMap((opener) => opener.split(' ')),
	'it',
	'that',
	'this',
	'them',
	'those',
	'all',
	'everything',
	'now',
	'please',
	'thanks',
	'thank',
	'you',
	'and',
	'just',
	'of',
	'course',
	'let',
	'us',
])

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * A short, clear yes: a few words that open with a yes or an approval and are made only of
 * approval and filler words, with no "no", "but", "wait" or question. "Yes", "I approve",
 * "sounds good, send it" and "sure, do that" count; "sure, what does it say" does not.
 */
export function isYes(text: string): boolean {
	const normalized = normalize(text)
	if (!normalized || text.includes('?')) return false
	const words = normalized.split(' ')
	if (words.length > MAX_YES_WORDS) return false
	if (words.some((word) => NO_WORDS.has(word))) return false
	if (!words.every((word) => YES_WORDS.has(word))) return false
	return YES_START.test(normalized)
}

/** True when the line turns the ask down. A line that is neither this nor a yes leaves the ask open. */
export function isNo(text: string): boolean {
	const words = normalize(text).split(' ')
	return words.some((word) => NO_WORDS.has(word))
}

const RISKY_TOOLS: ReadonlySet<string> = new Set([
	// Sends outside the workspace
	'gmail_send_email',
	'approve_object_draft',
	'post_conversation_message',
	'create_notification',
	// Starts work
	'create_session',
	'resume_session',
	'send_session_message',
	'create_trigger',
	'update_trigger',
	'create_loop',
	'update_loop',
	// Runs a command, changes access or credentials, creates or edits actors
	'desktop_run',
	'connect_integration',
	'disconnect_integration',
	'update_integration_access',
	'request_keychain_access',
	'request_integration_access',
	'request_keychain_credential',
	'create_actor',
	'update_actor',
	'stop_session',
	'desktop_type',
	'desktop_key',
	'desktop_click',
	'update_workspace',
	'create_extension',
	'update_extension',
	'create_workspace_skill',
	'update_workspace_skill',
])

/**
 * The risky class: the model must name the target and the effect when it asks.
 * Tools of an attached server (named server__tool) are in it too, because what
 * they do is unknown to us.
 */
export function isRiskyTool(name: string): boolean {
	return RISKY_TOOLS.has(name) || name.startsWith('delete_') || name.includes('__')
}

/**
 * The tool list the model is offered, with the repeat argument added to every
 * tool the gate can hold. Without it the model is told to send an argument its
 * tool definition does not list, which a strict vendor would refuse.
 */
export function withConfirmationArg<
	T extends { name: string; parameters: Record<string, unknown> },
>(tools: T[], readOnlyTools: ReadonlySet<string>): T[] {
	return tools.map((tool) => {
		if (readOnlyTools.has(tool.name)) return tool
		const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>
		return {
			...tool,
			parameters: {
				...tool.parameters,
				type: 'object',
				properties: {
					...properties,
					[VOICE_CONFIRM_ARG]: {
						type: 'string',
						description:
							'Only when repeating a call you were told is not done yet: the id from that answer. Never set it on a first call.',
					},
				},
			},
		}
	})
}

/** Same JSON whatever the key order, so "the same arguments" can be compared. */
function stableKey(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

type PendingState = 'open' | 'confirmed' | 'declined' | 'expired' | 'superseded'

interface PendingAction {
	id: string
	tool: string
	argsKey: string
	/** How many times the person had started speaking when the hold was made. */
	speechMark: number
	answer: 'yes' | 'no' | null
	state: PendingState
	timer: ReturnType<typeof setTimeout>
	waiters: Array<() => void>
}

export type WriteReview =
	| { kind: 'run' }
	| { kind: 'hold'; id: string; risky: boolean }
	| { kind: 'refuse'; reason: 'declined' | 'no_yes' }

export interface WriteGate {
	/** The person began a new utterance. item_id is the Realtime item the audio belongs to. */
	noteSpeechStarted(itemId?: string): void
	/** The transcript of one of the person's utterances arrived. */
	noteUserLine(text: string, itemId?: string): void
	/** Decides what a tool call may do. `args` is exactly what would be passed to the tool. */
	review(tool: string, args: unknown, confirmationId: string | null): Promise<WriteReview>
}

export function createWriteGate(deps: {
	voiceSessionId: string
	isReadOnlyTool: (name: string) => boolean
}): WriteGate {
	const { voiceSessionId, isReadOnlyTool } = deps
	let pending: PendingAction | null = null
	// Ids of holds the person turned down, so a model that repeats one is told no, not asked to ask again.
	const declinedIds = new Set<string>()
	let speechStarts = 0
	const speechIndexByItem = new Map<string, number>()

	function log(event: string, tool: string) {
		logger.info(`Voice write ${event}`, { voice_session_id: voiceSessionId, tool_name: tool })
	}

	function close(action: PendingAction, state: PendingState) {
		action.state = state
		clearTimeout(action.timer)
		if (pending === action) pending = null
		for (const wake of action.waiters.splice(0)) wake()
	}

	function hold(tool: string, argsKey: string): PendingAction {
		if (pending) {
			log('superseded', pending.tool)
			close(pending, 'superseded')
		}
		const action: PendingAction = {
			id: randomUUID(),
			tool,
			argsKey,
			speechMark: speechStarts,
			answer: null,
			state: 'open',
			waiters: [],
			timer: setTimeout(() => {
				if (action.state !== 'open') return
				log('expired', action.tool)
				close(action, 'expired')
			}, VOICE_CONFIRM_TTL_MS),
		}
		action.timer.unref?.()
		pending = action
		log('held', tool)
		return action
	}

	/** Resolves when the person has answered the hold, it was closed, or the wait ran out. */
	function waitForAnswer(action: PendingAction): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(done, VOICE_CONFIRM_WAIT_MS)
			function done() {
				clearTimeout(timer)
				resolve()
			}
			action.waiters.push(done)
		})
	}

	return {
		noteSpeechStarted(itemId) {
			speechStarts += 1
			if (!itemId) return
			speechIndexByItem.set(itemId, speechStarts)
			if (speechIndexByItem.size > 50) {
				const oldest = speechIndexByItem.keys().next().value
				if (oldest !== undefined) speechIndexByItem.delete(oldest)
			}
		},

		noteUserLine(text, itemId) {
			const action = pending
			if (!action || action.state !== 'open' || action.answer !== null) return
			// Only speech that began after the hold can answer it. A line we cannot
			// place in time (no item id, or one we never saw start) is ignored: no yes
			// is heard rather than a wrong one.
			const index = itemId ? speechIndexByItem.get(itemId) : undefined
			if (index === undefined || index <= action.speechMark) return
			if (isYes(text)) {
				action.answer = 'yes'
				for (const wake of action.waiters.splice(0)) wake()
				return
			}
			// A question or an aside is not an answer: the ask stays open for the person's yes or no.
			if (!isNo(text)) return
			action.answer = 'no'
			log('declined', action.tool)
			declinedIds.add(action.id)
			close(action, 'declined')
		},

		async review(tool, args, confirmationId) {
			if (isReadOnlyTool(tool) || !isRiskyTool(tool)) return { kind: 'run' }
			if (confirmationId !== null && declinedIds.has(confirmationId)) {
				return { kind: 'refuse', reason: 'declined' }
			}
			const argsKey = stableKey(args)
			const action = pending
			const repeats =
				action !== null &&
				confirmationId !== null &&
				action.id === confirmationId &&
				action.tool === tool &&
				action.argsKey === argsKey
			if (!repeats) return { kind: 'hold', id: hold(tool, argsKey).id, risky: isRiskyTool(tool) }

			if (action.answer === null) await waitForAnswer(action)
			if (action.state === 'declined') return { kind: 'refuse', reason: 'declined' }
			if (action.state !== 'open') {
				// Expired or replaced while we waited: the yes, if any, no longer counts.
				return { kind: 'hold', id: hold(tool, argsKey).id, risky: isRiskyTool(tool) }
			}
			if (action.answer !== 'yes') return { kind: 'refuse', reason: 'no_yes' }
			log('confirmed', tool)
			close(action, 'confirmed')
			return { kind: 'run' }
		},
	}
}
