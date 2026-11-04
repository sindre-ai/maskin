import { randomUUID } from 'node:crypto'
import { logger } from '../lib/logger'
import type { HoldPreview } from './voice-hold-preview'

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
 * The yes is tied to the text the person was asked about. A hold carries a preview of what the
 * call will do (voice-hold-preview.ts) and a fingerprint of it. When the model repeats the call,
 * the fingerprint is worked out again from the target. If the text changed since the question,
 * the yes does not count: the repeat becomes a new hold with the new text.
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

/** Words that may open a yes, alone or stacked: "yes", "okay sure". */
const LEAD_WORDS = new Set([
	'yes',
	'yeah',
	'yep',
	'yup',
	'ja',
	'jep',
	'sure',
	'ok',
	'okay',
	'alright',
	'absolutely',
	'definitely',
	'exactly',
	'agreed',
	'perfect',
	'great',
	'fine',
	'please',
	// Danish
	'jo',
	'selvfølgelig',
	'absolut',
	'perfekt',
	'enig',
	'præcis',
	'fint',
	'godt',
	'super',
	'flot',
])
/**
 * Lead words that are a yes on their own. "please", "fine", "great", "alright" and "exactly"
 * are not: they are as often a reaction or a polite opener as an approval, so they only count
 * in front of an approval phrase ("great, send it").
 */
const AFFIRM_ALONE = new Set([
	'yes',
	'yeah',
	'yep',
	'yup',
	'ja',
	'jep',
	'sure',
	'ok',
	'okay',
	'absolutely',
	'definitely',
	'agreed',
	'perfect',
	'jo',
	'selvfølgelig',
	'absolut',
	'perfekt',
	'enig',
])
/** Words that may close a yes: "go ahead please", "send it now". */
const TAIL_WORDS = new Set(['please', 'now', 'thanks', 'tak', 'nu', 'bare', 'venligst'])
/**
 * The approvals a yes may be made of. A line is a yes only if, after the lead and tail words,
 * every word belongs to one of these phrases (joined by "and" at most). It is a closed list on
 * purpose: a word-by-word whitelist let "is that right", "please correct it" and "okay confirm
 * it" through, because their words are each fine on their own.
 */
const APPROVAL_PHRASES = [
	'go ahead',
	'go for it',
	'do it',
	'do that',
	'send it',
	'send that',
	'send them',
	'send',
	'approve',
	'approve it',
	'approve that',
	'approve all',
	'approved',
	'i approve',
	'i agree',
	'confirmed',
	'sounds good',
	'sounds great',
	'looks good',
	'all good',
	'that works',
	'thats right',
	'that is right',
	'thats correct',
	'that is correct',
	'lets do it',
	'lets do that',
	'let us do it',
	'of course',
	'for sure',
	// Danish
	'send den',
	'send det',
	'send dem',
	'send den afsted',
	'send det afsted',
	'send dem afsted',
	'afsted',
	'godkend',
	'godkend den',
	'godkend det',
	'godkend alle',
	'godkendt',
	'jeg godkender',
	'det er godkendt',
	'bekræftet',
	'jeg bekræfter',
	'jeg er enig',
	'det lyder godt',
	'det lyder fint',
	'det ser godt ud',
	'det ser fint ud',
	'det passer',
	'det er rigtigt',
	'det er korrekt',
	'det er fint',
	'det er i orden',
	'i orden',
	'gør det',
	'kør',
	'kør på',
	'sæt i gang',
	'lad os gøre det',
	'helt sikkert',
	'selvfølgelig',
	'absolut',
	'gerne',
].map((phrase) => phrase.split(' '))
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
	// Danish
	'ikke',
	'ingen',
	'vent',
	'men',
	'kun',
	'aldrig',
	'annuller',
	'senere',
	'ændre',
	'rediger',
	'undlad',
	'dog',
	'faktisk',
	'stedet',
	'uden',
])
const MAX_YES_WORDS = 8

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-zæøå\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** True when `words` is one or more approval phrases, optionally joined by "and". */
function isApprovalRun(words: string[]): boolean {
	if (words.length === 0) return true
	if (words[0] === 'and' || words[0] === 'og')
		return words.length > 1 && isApprovalRun(words.slice(1))
	return APPROVAL_PHRASES.some(
		(phrase) =>
			phrase.length <= words.length &&
			phrase.every((word, i) => words[i] === word) &&
			isApprovalRun(words.slice(phrase.length)),
	)
}

/**
 * A short, clear yes: lead words ("yes", "okay sure"), then approval phrases ("go ahead and
 * send it"), then tail words ("please", "now"), and nothing else. The lists hold English and
 * Danish ("ja, send den", "det lyder godt", "godkend alle"). "I approve", "sounds good,
 * send it" and "sure, do that" count; "sure, what does it say", "okay is that right" and
 * "please correct it" do not, and neither does anything with a no, "but", "wait" or question mark.
 */
export function isYes(text: string): boolean {
	// Only English and Danish letters (a-z, æ, ø, å) and plain punctuation can be a yes.
	// normalize() turns everything else into a space, so without this "send 500", "approve #3"
	// or "yes 5" would read as a bare approval with its number thrown away; other accented
	// letters would be thrown away the same way.
	if (/[^a-zæøå\s.,!;:'’"-]/i.test(text)) return false
	const normalized = normalize(text)
	if (!normalized) return false
	const words = normalized.split(' ')
	if (words.length > MAX_YES_WORDS) return false
	if (words.some((word) => NO_WORDS.has(word))) return false
	let start = 0
	while (start < words.length && LEAD_WORDS.has(words[start] as string)) start += 1
	let end = words.length
	while (end > start && TAIL_WORDS.has(words[end - 1] as string)) end -= 1
	// "thank you" is two words; the loop above removes "you" only if "thank" is not a tail word.
	if (end > start && words[end - 1] === 'you' && words[end - 2] === 'thank') end -= 2
	const core = words.slice(start, end)
	// Lead words alone are a yes only if one of them is a plain affirmative ("yes", "okay sure").
	if (core.length === 0) return words.slice(0, start).some((word) => AFFIRM_ALONE.has(word))
	return isApprovalRun(core)
}

/** True when the line turns the ask down. A line that is neither this nor a yes leaves the ask open. */
export function isNo(text: string): boolean {
	const words = normalize(text).split(' ')
	return words.some((word) => NO_WORDS.has(word))
}

const RISKY_TOOLS: ReadonlySet<string> = new Set([
	// Sends outside the workspace
	'gmail_send_email',
	'resend_send_email',
	'approve_object_draft',
	'post_conversation_message',
	'create_notification',
	// Starts work
	'create_session',
	// Deprecated alias of create_session (packages/mcp/src/tool-aliases.ts): same effect, same hold.
	'run_agent',
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
	'add_mcp_server',
	'request_keychain_credential',
	'create_actor',
	'update_actor',
	'stop_session',
	'desktop_type',
	'desktop_key',
	'desktop_click',
	'desktop_drag',
	'desktop_put_file',
	// Opens a port of the desktop to the outside
	'desktop_expose_port',
	'update_workspace',
	'create_extension',
	'update_extension',
	'create_workspace_skill',
	'update_workspace_skill',
])

/**
 * Ordinary changes inside the workspace: recorded in the events log and easy to change back. A
 * direct call to one runs at once, and so does one made on behalf of ask_workspace. Every other
 * write a delegated call makes is held (see isRiskyTool's `delegated` flag).
 */
export const ORDINARY_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'create_objects',
	'update_objects',
	'create_comment',
	'mark_read',
	// An edge between two objects; deleting one is delete_relationship, which is held.
	'create_relationship',
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
 * The hold rule for a call made on behalf of ask_workspace: the default is inverted. Whatever is
 * not read-only and not an ordinary workspace write is held, so a tool added later (or an alias of
 * one) is held until someone decides it is safe, instead of running unasked because nobody listed it.
 */
export function isHeldWhenDelegated(name: string, isReadOnly: boolean): boolean {
	if (isReadOnly) return false
	return isRiskyTool(name) || !ORDINARY_WRITE_TOOLS.has(name)
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
	/** What the call would do when it was held; null when no preview could be made. */
	fingerprint: string | null
	/** What the held call would do, in a few words; never the text of a draft. */
	summary: string
	/** Yeses already heard for earlier holds of this same send, whose text then changed. */
	yesCarried: number
	answer: 'yes' | 'no' | null
	state: PendingState
	timer: ReturnType<typeof setTimeout>
	waiters: Array<() => void>
}

/** What the gate knows about a send that went through a yes. */
export interface ConfirmedSend {
	holdId: string
	/** Yeses the person gave before it ran: 1, or more when the text changed after a yes. */
	yesCount: number
	/** The text read back before the yes is the text sent. Null when no preview could be made. */
	readBackMatches: boolean | null
}

/** A hold that ended without the call running. */
export interface HoldEnd {
	id: string
	tool: string
	summary: string
	state: 'declined' | 'expired' | 'superseded'
	yesCount: number
	/** The arguments of the held call, in a stable form. */
	argsKey: string
	/**
	 * For superseded: the call that replaced it. The same tool with the same arguments means the same
	 * send, asked again; the same tool with other arguments is a different send.
	 */
	replacedByTool?: string
	replacedByArgsKey?: string
}

export interface PendingHoldInfo {
	tool: string
	summary: string
	yesCount: number
}

export type WriteReview =
	| { kind: 'run'; confirmed?: ConfirmedSend }
	| {
			kind: 'hold'
			id: string
			risky: boolean
			/** True when the hold is a decision on a card, held only because a filler sound must not decide. */
			decision: boolean
			preview: HoldPreview | null
			/** True when the person had been asked about other text, so their yes was thrown away. */
			changed: boolean
	  }
	| { kind: 'refuse'; reason: 'declined' | 'no_yes' }

export interface WriteGate {
	/** The person began a new utterance. item_id is the Realtime item the audio belongs to. */
	noteSpeechStarted(itemId?: string): void
	/** The transcript of one of the person's utterances arrived. */
	noteUserLine(text: string, itemId?: string): void
	/** Decides what a tool call may do. `args` is exactly what would be passed to the tool. */
	review(
		tool: string,
		args: unknown,
		confirmationId: string | null,
		opts?: { delegated?: boolean },
	): Promise<WriteReview>
	/** The hold still waiting for the person's yes or no, if any. */
	pendingHold(): PendingHoldInfo | null
}

export function createWriteGate(deps: {
	voiceSessionId: string
	isReadOnlyTool: (name: string) => boolean
	/** What the call would do right now, from its target. Without it a hold has no preview. */
	previewFor?: (tool: string, args: unknown) => Promise<HoldPreview>
	/** Told once for every hold that ends without running: turned down, timed out or replaced. */
	onHoldEnded?: (end: HoldEnd) => void
	/**
	 * True when this call would record the person's decision on a card (a comment or status change on
	 * a decision card). Such a call is held like a risky one, so it only runs after the person has
	 * said a clear yes to a read-back: "mm" or "go on" is never a decision.
	 */
	isDecisionWrite?: (tool: string, args: unknown) => boolean
}): WriteGate {
	const { voiceSessionId, isReadOnlyTool, previewFor, onHoldEnded, isDecisionWrite } = deps
	let pending: PendingAction | null = null
	// Ids of holds the person turned down, so a model that repeats one is told no, not asked to ask again.
	const declinedIds = new Set<string>()
	let speechStarts = 0
	const speechIndexByItem = new Map<string, number>()

	function log(event: string, tool: string) {
		logger.info(`Voice write ${event}`, { voice_session_id: voiceSessionId, tool_name: tool })
	}

	function close(
		action: PendingAction,
		state: PendingState,
		replacedBy?: { tool: string; argsKey: string },
	) {
		const wasOpen = action.state === 'open'
		action.state = state
		clearTimeout(action.timer)
		if (pending === action) pending = null
		for (const wake of action.waiters.splice(0)) wake()
		if (wasOpen && (state === 'declined' || state === 'expired' || state === 'superseded')) {
			try {
				onHoldEnded?.({
					id: action.id,
					tool: action.tool,
					summary: action.summary,
					state,
					yesCount: action.yesCarried + (action.answer === 'yes' ? 1 : 0),
					argsKey: action.argsKey,
					...(replacedBy
						? { replacedByTool: replacedBy.tool, replacedByArgsKey: replacedBy.argsKey }
						: {}),
				})
			} catch (err) {
				logger.warn('Voice hold-ended listener failed', {
					voice_session_id: voiceSessionId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	/** The preview, or null when there is none or the lookup failed: a failure must not drop the call. */
	async function currentPreview(tool: string, args: unknown): Promise<HoldPreview | null> {
		if (!previewFor) return null
		try {
			return await previewFor(tool, args)
		} catch (err) {
			logger.warn('Voice hold preview failed', {
				voice_session_id: voiceSessionId,
				tool_name: tool,
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		}
	}

	function hold(
		tool: string,
		argsKey: string,
		fingerprint: string | null,
		summary: string,
		yesCarried: number,
	): PendingAction {
		if (pending) {
			log('superseded', pending.tool)
			close(pending, 'superseded', { tool, argsKey })
		}
		const action: PendingAction = {
			id: randomUUID(),
			tool,
			argsKey,
			speechMark: speechStarts,
			fingerprint,
			summary,
			yesCarried,
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

	async function holdWithPreview(
		tool: string,
		args: unknown,
		argsKey: string,
		known?: HoldPreview | null,
		yesCarried = 0,
		risky = isRiskyTool(tool),
	): Promise<WriteReview> {
		// Looked up before the hold is made, so nothing awaits between making it and returning it.
		const preview = known !== undefined ? known : await currentPreview(tool, args)
		const changed = known !== undefined
		const action = hold(
			tool,
			argsKey,
			preview?.fingerprint ?? null,
			preview?.summary ?? tool.replace(/_/g, ' '),
			yesCarried,
		)
		return {
			kind: 'hold',
			id: action.id,
			risky,
			decision: isDecisionWrite?.(tool, args) ?? false,
			preview,
			changed,
		}
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

		async review(tool, args, confirmationId, opts) {
			if (isReadOnlyTool(tool)) return { kind: 'run' }
			const delegated = opts?.delegated === true
			const risky = delegated ? isHeldWhenDelegated(tool, false) : isRiskyTool(tool)
			if (!risky && !isDecisionWrite?.(tool, args)) return { kind: 'run' }
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
			if (!repeats) return holdWithPreview(tool, args, argsKey, undefined, 0, risky)

			if (action.answer === null) await waitForAnswer(action)
			if (action.state === 'declined') return { kind: 'refuse', reason: 'declined' }
			const yesesHeard = action.yesCarried + (action.answer === 'yes' ? 1 : 0)
			if (action.state !== 'open') {
				// Expired or replaced while we waited: the yes, if any, no longer counts.
				return holdWithPreview(tool, args, argsKey, undefined, yesesHeard, risky)
			}
			if (action.answer !== 'yes') return { kind: 'refuse', reason: 'no_yes' }
			// The yes was for the text the person was asked about. Work the fingerprint out again from the
			// target now: the arguments (an object id) stay the same when the text behind them changes.
			const latest = await currentPreview(tool, args)
			if (action.state !== 'open')
				return holdWithPreview(tool, args, argsKey, latest, yesesHeard, risky)
			if ((latest?.fingerprint ?? null) !== action.fingerprint) {
				log('stale', tool)
				return holdWithPreview(tool, args, argsKey, latest, yesesHeard, risky)
			}
			log('confirmed', tool)
			close(action, 'confirmed')
			return {
				kind: 'run',
				confirmed: {
					holdId: action.id,
					yesCount: yesesHeard,
					readBackMatches: action.fingerprint === null ? null : true,
				},
			}
		},

		pendingHold() {
			const action = pending
			if (!action || action.state !== 'open') return null
			return {
				tool: action.tool,
				summary: action.summary,
				yesCount: action.yesCarried + (action.answer === 'yes' ? 1 : 0),
			}
		},
	}
}
