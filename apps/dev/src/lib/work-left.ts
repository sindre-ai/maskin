/**
 * Detects a chat reply that ends with work the agent could still do (bet "Agents take the lead",
 * task "Send a turn back if work remains", stage 1).
 *
 * Phrases only flag. A match means "send this turn back once"; no match proves nothing, and no
 * phrase is ever the reason a turn is let through. Stage 2 will decide from state instead.
 *
 * Four endings count:
 *  - `next_step_announced`: "Next I'll run those lookups" with nothing started.
 *  - `permission_question`: "Do you want me to go ahead?" about a step that sends nothing.
 *  - `offer_more`: "Let me know if you want me to look at anything else".
 *  - `nothing_scheduled`: "Nothing is scheduled", "I haven't started".
 * Only the first is flagged on its own. The others are courtesy phrases in an ordinary answer, so
 * they count only when the turn ran at least one tool (the agent was doing work, not answering).
 *
 * Let through, whatever the phrase: the question is about a step that sends in a person's name,
 * spends or deletes; or the reply says a wake-up is set; or the sentence with the phrase names a
 * real wait (an outside thing that must finish first, or a time). Plain work verbs are not waits.
 *
 * Pure functions, no I/O, so each rule is tested apart.
 */

export type WorkLeftKind =
	| 'next_step_announced'
	| 'permission_question'
	| 'offer_more'
	| 'nothing_scheduled'

export interface WorkLeftMatch {
	kind: WorkLeftKind
	/** True when the phrase is a courtesy that only counts if the turn ran a tool. */
	needsToolCalls: boolean
}

/** Only the end of the reply is read: a closing line is what leaves work undone. */
const TAIL_CHARS = 500

const NEXT_STEP_ANNOUNCED_RE =
	/\b(?:next(?:\s+step)?[,:]?\s+i(?:'ll|\s+will|\s+am going to)|i(?:'ll|\s+will)\s+next|i(?:'ll|\s+will)\s+now\s+(?:go on|move on|continue|proceed)|then\s+i(?:'ll|\s+will)\s+(?:run|source|find|score|look|check|draft|build|pull))\b/i

const PERMISSION_QUESTION_RE =
	/\b(?:do you want me to|would you like me to|want me to|shall i|should i(?:\s+go ahead|\s+proceed|\s+continue|\s+start)?|can i go ahead|may i go ahead|ok(?:ay)? (?:if|for me to) i)\b[^.?!]{0,200}\?/i

const OFFER_MORE_RE =
	/\b(?:let me know if|say if you(?:'d)? (?:want|like)|tell me if you(?:'d)? (?:want|like)|anything else (?:you(?:'d)? like|i can)|what should i (?:start(?: on)?|work on|do) next|what(?:'s| is) next for me)\b/i

const NOTHING_SCHEDULED_RE =
	/\b(?:nothing (?:is |has been )?scheduled|i haven't started|i have not started|not started yet|nothing (?:is |has been )?started)\b/i

/**
 * A step that sends in a person's name, spends or deletes: asking first is right, so the question
 * is never sent back. Word-boundary verbs, so "contacts" (a noun) does not match.
 */
const SENSITIVE_STEP_RE =
	/\b(?:send|sending|email|e-mail|publish|publishing|delete|deleting|remove|removing|pay|paying|purchase|buy|spend|charge|invite|inviting|reach out|dm|merge|merging|deploy|deploying|release|submit|submitting|book|cancel|sign up|approve)\b|\bpost(?:ing)?\b(?!-)|\bmessage (?:him|her|them|the)\b|\bcontact (?:him|her|them)\b/i

/** The reply says a wake-up is set, so nothing is left to do now. Read over the whole closing text. */
const WAKE_UP_SET_RE =
	/\bi(?:'ve| have) (?:scheduled\b|(?:set(?: up)?|created|added) (?:a|an|the|my) (?:wake-?up|reminder|trigger|follow-?up|timer|next check)\b)|\b(?:wake-?up|reminder|trigger|follow-?up) (?:is|has been) (?:set|scheduled|created)\b/i

/**
 * The sentence names a real wait: an outside thing that has to finish first, or a time. Read only
 * in the sentence that carries the match, so a wait mentioned elsewhere does not excuse it, and
 * plain work verbs ("look at", "check on") are not waits.
 */
const REAL_WAIT_RE =
	/\bwaiting (?:for|on)\b|\b(?:once|after|when|until) (?:it|that|this|you|they|the [\w\s-]{1,30}?) (?:finish(?:es)?|complete[sd]?|lands?|(?:is|are) (?:merged|ready|done)|builds|passes|comes? back|repl(?:y|ies)|answers|arrives?)\b|\b(?:tomorrow|tonight|later today)\b(?!'s)|\bin (?:an?|\d+|a few|two|three) (?:minutes?|hours?|days?)\b/i

function tailOf(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > TAIL_CHARS ? trimmed.slice(-TAIL_CHARS) : trimmed
}

/** The last sentence-ish chunk that carries the match, so a sensitive verb elsewhere does not excuse it. */
function sentenceAround(text: string, index: number): string {
	const start = Math.max(
		text.lastIndexOf('.', index - 1),
		text.lastIndexOf('!', index - 1),
		text.lastIndexOf('\n', index - 1),
	)
	return text.slice(start + 1, index + 260)
}

/** The whole sentence that carries the match, from the previous stop to the next one. */
function sentenceOf(text: string, index: number): string {
	const start = Math.max(
		text.lastIndexOf('.', index - 1),
		text.lastIndexOf('!', index - 1),
		text.lastIndexOf('?', index - 1),
		text.lastIndexOf('\n', index - 1),
	)
	const rest = text.slice(index)
	const stop = rest.search(/[.!?\n]/)
	return text.slice(start + 1, stop === -1 ? text.length : index + stop)
}

/** True when the sentence with the match names a real wait. */
function isRealWait(text: string, index: number): boolean {
	return REAL_WAIT_RE.test(sentenceOf(text, index))
}

/** Null when the reply ends cleanly or is one of the endings that are let through. */
export function detectWorkLeft(text: string): WorkLeftMatch | null {
	const tail = tailOf(text)
	if (!tail) return null
	if (WAKE_UP_SET_RE.test(tail)) return null

	const next = NEXT_STEP_ANNOUNCED_RE.exec(tail)
	if (next) {
		if (isRealWait(tail, next.index)) return null
		return { kind: 'next_step_announced', needsToolCalls: false }
	}

	const offer = OFFER_MORE_RE.exec(tail)
	if (offer) {
		if (SENSITIVE_STEP_RE.test(sentenceAround(tail, offer.index))) return null
		if (isRealWait(tail, offer.index)) return null
		return { kind: 'offer_more', needsToolCalls: true }
	}

	const permission = PERMISSION_QUESTION_RE.exec(tail)
	if (permission) {
		if (SENSITIVE_STEP_RE.test(sentenceAround(tail, permission.index))) return null
		if (isRealWait(tail, permission.index)) return null
		return { kind: 'permission_question', needsToolCalls: true }
	}

	const idle = NOTHING_SCHEDULED_RE.exec(tail)
	if (idle) {
		if (isRealWait(tail, idle.index)) return null
		return { kind: 'nothing_scheduled', needsToolCalls: true }
	}
	return null
}

/** What the model is told. Addressed to the model, never shown in the chat. */
const SEND_BACK_REASON: Record<WorkLeftKind, string> = {
	next_step_announced: 'you named a next step you can do now and did not start it',
	permission_question:
		"you asked permission for a step that sends nothing in anyone's name, spends nothing and deletes nothing",
	offer_more: 'you closed by offering more work instead of doing the next piece of it',
	nothing_scheduled: 'you said nothing is started or scheduled, and left it there',
}

/**
 * The correction written to the model's stdin as a user turn. States the mistake and what to do
 * instead, with the honest exits (a step that needs a person's yes, or a real wait) spelled out.
 */
export function buildSendBackNudge(kind: WorkLeftKind): string {
	return `[system correction] Your last reply ended with work you could still do: ${SEND_BACK_REASON[kind]}. Do that work now, with your tools, instead of announcing it or asking. Only stop to ask a person when the step sends something in their name, spends money, deletes something, or needs information only they have. If you are really waiting on something, say what you are waiting on and set a wake-up for it before you end. End with what you did, in prose, for the human.`
}
