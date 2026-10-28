import { logger } from '../lib/logger'

/** The attached skills stay under this many characters in total; the longest go first. */
export const VOICE_SKILLS_TOTAL_MAX_CHARS = 24_000

export type VoiceSkill = { name: string; content: string }

function formatMoment(at: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(at)
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
	return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`
}

/**
 * Who is on the call and when it is for them. The caller's own time zone is used when it
 * is stored and valid; otherwise the time is given in UTC, so the agent never guesses.
 */
export function formatVoiceCallerContext(args: {
	callerName: string | null
	timezone: string | null
	now?: Date
}): string {
	const now = args.now ?? new Date()
	let moment = `${formatMoment(now, 'UTC')} UTC`
	if (args.timezone) {
		try {
			moment = `${formatMoment(now, args.timezone)} (${args.timezone})`
		} catch {
			// An unknown stored time zone falls back to UTC.
		}
	}
	const who = args.callerName?.trim()
	return [
		who ? `You are speaking with ${who}.` : '',
		`It is now ${moment}.`,
		'Use this to resolve words like today, tomorrow and next week.',
	]
		.filter(Boolean)
		.join(' ')
}

/**
 * The skills that fit the size cap, in their original order. When the total is over, the
 * longest skills are dropped first and each drop is logged, so one big skill cannot blow
 * up the call setup.
 */
export function capVoiceSkills<T extends VoiceSkill>(
	skills: T[],
	context: { voiceSessionId: string },
): T[] {
	let total = skills.reduce((sum, s) => sum + s.content.length, 0)
	if (total <= VOICE_SKILLS_TOTAL_MAX_CHARS) return skills

	const dropped = new Set<T>()
	for (const skill of [...skills].sort((a, b) => b.content.length - a.content.length)) {
		if (total <= VOICE_SKILLS_TOTAL_MAX_CHARS) break
		dropped.add(skill)
		total -= skill.content.length
	}
	logger.warn('Voice call skills over the size cap; dropped the longest', {
		voice_session_id: context.voiceSessionId,
		cap_chars: VOICE_SKILLS_TOTAL_MAX_CHARS,
		dropped_skills: [...dropped].map((s) => s.name),
	})
	return skills.filter((s) => !dropped.has(s))
}

/**
 * Who the caller is is already given by formatVoiceCallerContext. This adds the part that
 * stops the agent asking and keeps it on their own items: the id is what the lookups key on.
 */
export function formatVoiceCallerRules(args: { callerName: string | null; callerId: string }) {
	const who = args.callerName?.trim() || 'the caller'
	return `${who} is signed in (actor id ${args.callerId}) and already known to you: never ask who they are. When you look up approvals, For You items, tasks or anything waiting on someone, use ${who}'s own, and do not read out other people's.`
}

/**
 * Ordinary changes inside the workspace run at once. Risky ones (sending outside, starting
 * work, deleting, access and credentials, tools of attached servers) are held until the
 * person says yes, and the server only counts a yes spoken AFTER the hold
 * (services/voice-write-gate.ts). So the agent must not ask first: a yes given before the
 * hold is thrown away and the person is asked a second time.
 */
export const VOICE_WRITE_CONFIRMATION =
	'Reading, searching and ordinary changes inside the workspace (updating a task or status, adding a comment, creating a task, marking something read) run at once: just do them, then say in a few words what you did. Anything that sends outside the workspace, starts work, deletes, or changes access or credentials is held by the system until the person says yes out loud. Make that call straight away, without asking first: a yes spoken before the call is held does not count. When the call comes back as not done yet, it carries the real recipient, subject and text of what will happen, and says how much of it to read aloud: follow that, ask for a yes once, wait for their answer, then repeat the same call with the confirmation_id you were given. If the text changed after you asked, the earlier yes does not count and you ask again about the new text. Never ask twice for the same thing.'

/**
 * Rules for drafts and for what the agent claims on a call. The server guards the send itself
 * (the yes is tied to the text, a draft can only be approved by a person's tap); these lines keep
 * the agent from promising what the server will not do. Its own constant, apart from the others,
 * so edits to them do not collide with it.
 */
export const VOICE_DRAFT_RULE =
	'Drafts and cards: when the person changes the wording of a draft, first save the new wording with update_objects on the draft\'s task, read back what was saved from the result, and only then ask for approval. Never ask for approval of wording you have not saved. A draft is approved by tapping it in the chat, and a decision card is answered by tapping it: a spoken yes does not approve a draft or answer a card, so say it is in the chat for them to tap. Say a background job is running or done only from a tool result you received in this same turn. Otherwise say it was started and check before you report. Say a change is done only after its tool result says it ran: the chat shows a receipt of what this call really did, so never say "done" or "I\'ll record that" for something whose result you have not seen.'

export const VOICE_CALL_CONDUCT = `How to run this call:
- Lead with the point. For a list, say how many there are, then start on the first one with your recommendation. One short hello at most, and no "let me think about...", no narrating what you are about to do. If a tool call will take a moment, make it and speak when you have the result.
- Do one item at a time, with the full content ready before you speak. When you do read or quote a draft or message aloud, use the language it is written in, never a translation.
- The person is listening, not reading. For a draft, a list, or anything they must read or open, call show_in_chat to put it in this call's chat, then speak only a short summary. A link they must open (connecting an integration, a credential, an approval) goes in the chat the same way: never read an address out loud.
- Say what you cannot do in your first sentence about it, and who does it instead.
- Speech recognition on a call is imperfect. If a sentence is garbled, off topic or in a language the call was not using, say "Sorry, I didn't catch that" and wait. Do not act on it or build an answer around it.
- If the caller says something is generic, wrong or not worth doing, move on or fix it. Look in the records you can read for the specifics before asking them to supply it.
- Keep a short running tally of what was decided, and give it when they ask what is left or when the call winds down.`

/** Which language the agent speaks. The model hears the raw audio, so this is about the reply, not the transcript. */
export const VOICE_LANGUAGE_RULE =
	'Reply in the language the person is speaking, and follow them if they switch. People on this call speak Danish and English and often mix them. When you speak Danish, use natural spoken Danish, not a word-for-word translation of English, and pronounce Danish words and names as Danish. When you read out text that is written in Danish, read it as Danish.'

/**
 * What needs the caller comes from the same ranked list the web For You page shows. Its own
 * constant, apart from VOICE_CALL_CONDUCT, so edits to the conduct bullets do not collide with it.
 */
export const VOICE_FOR_YOU_RULE =
	'To say what needs the caller, call list_for_you with their actor id (given above), not list_notifications. Start with the top card, and say first any card whose due_at is today.'

export interface VoiceInstructionsInput {
	systemPrompt: string | null
	workspaceId: string
	voiceSessionId: string
	caller: { id: string; name: string | null; timezone: string | null }
	skills: VoiceSkill[]
	/** The earlier messages of the chat the call was started from, already formatted. */
	chatHistory: string
	now?: Date
}

/** The whole briefing for a call, in the order the agent should weigh it. */
export function buildVoiceInstructions(input: VoiceInstructionsInput): string {
	return [
		input.systemPrompt ?? '',
		`\n\n${formatVoiceCallerContext({ callerName: input.caller.name, timezone: input.caller.timezone, now: input.now })}`,
		`\n\n${formatVoiceCallerRules({ callerName: input.caller.name, callerId: input.caller.id })}`,
		`\n\nThe current workspace id is ${input.workspaceId}. Pass it as workspace_id to tools that take one.`,
		`\n\n${VOICE_WRITE_CONFIRMATION}`,
		`\n\n${VOICE_DRAFT_RULE}`,
		`\n\n${VOICE_CALL_CONDUCT}`,
		`\n\n${VOICE_LANGUAGE_RULE}`,
		`\n\n${VOICE_FOR_YOU_RULE}`,
		...capVoiceSkills(input.skills, { voiceSessionId: input.voiceSessionId }).map(
			(row) => `\n\n## Skill: ${row.name}\n\n${row.content}`,
		),
		input.chatHistory ? `\n\n${input.chatHistory}` : '',
	]
		.join('')
		.trim()
}
