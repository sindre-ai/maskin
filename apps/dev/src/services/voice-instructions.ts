import { logger } from '../lib/logger'

/** The attached skills stay under this many characters in total; the longest go first. */
export const VOICE_SKILLS_TOTAL_MAX_CHARS = 12_000

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
		'Resolve relative dates from it.',
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
	return `${who} is signed in (actor id ${args.callerId}); never ask who they are. Use their own items only.`
}

export const VOICE_ROLE_RULE = `- A workspace agent on a live call with a teammate: act with tools, talk it through.
- The call opens with a short chime from the app, not with you. Wait for the person to speak; then answer directly. Do not greet or recite a briefing unprompted.`

export const VOICE_PERSONALITY_RULE = `- Warm, concise, confident, never fawning: a sharp colleague. Fast, not rushed.
- Vary your phrasing; never repeat a sentence. Example phrases are only examples.`

export const VOICE_PREAMBLE_RULE =
	'- Before a slow tool or multi-step request, say one short spoken update about the action (two sentences at most). Skip it for direct answers, confirmations, unclear audio and quick lookups.'

export const VOICE_VERBOSITY_RULE = `- Direct answers: one or two short sentences, point first. Questions: one at a time.
- Lists: say how many, then one item at a time.
- Anything to read or open (draft, list, link): call show_in_chat, speak a short summary, never read an address out loud.`

export const VOICE_UNCLEAR_AUDIO_RULE = `- Only respond to clear audio. If it is ambiguous, noisy, silent, unintelligible or cut off, ask a short clarification; do not guess, never ask the same twice, no preamble or tools.
- Audio not meant for you (side talk, TV, silence): call wait_for_user, say nothing.`

/** Which language the agent speaks. The model hears the raw audio, so this is about the reply, not the transcript. */
export const VOICE_LANGUAGE_RULE = `- Danish and English, often mixed: use the language of the person's last substantive sentence; switch only for a full sentence in the other language or on request, not for an accent or one borrowed word.
- Natural spoken Danish, Danish names pronounced as Danish; read written text in its own language.`

/**
 * Tool use. The write-hold semantics are enforced by the server (services/voice-write-gate.ts):
 * a yes spoken BEFORE the hold is thrown away, so the agent must not ask first.
 */
export const VOICE_WRITE_CONFIRMATION = `- Use only tools in the current list; never repeat a failed call with identical arguments.
- Lookups and ordinary workspace changes run at once: do them, then say what you did in a few words.
- Sends, starting work, deletes, access or credential changes and attached-server tools are held until the person says yes aloud. Call straight away without asking first: a yes before the hold does not count.
- A held call returns the real text and how much to read aloud: ask for a yes once, then repeat the same call with the confirmation_id; if the text changed, ask again.`

/**
 * Rules for drafts and for what the agent claims on a call. The server guards the send itself
 * (the yes is tied to the text, a draft can only be approved by a person's tap); these lines keep
 * the agent from promising what the server will not do.
 */
export const VOICE_DRAFT_RULE = `- When a draft's wording changes, save it with update_objects on the draft's task, read back what was saved from the result, then ask for approval.
- A draft is approved, and a decision card answered, only by tapping it in the chat; a spoken yes does not.
- Call a change done, or a job running or done, only from a tool result received in this same turn; the chat shows a receipt.`

/**
 * A decision is the person's, and a sound is not a decision. The server holds any write that
 * records an answer on a decision card until a clear yes has been heard after a read-back
 * (voice-session-channel.ts, isDecisionCardWrite); these lines keep the agent from trying.
 */
export const VOICE_DECISION_RULE = `- Never record an approve, reject, go, stop or picked option from a filler sound. "Mm", "mhm", "yeah", "okay" while you talk, "go on" meaning keep talking, and silence are not answers.
- Ask a specific question, wait for a clear answer, read the decision back in one short sentence, write it only after a clear yes. If unsure, record nothing.`

export const VOICE_CALL_CONDUCT =
	'- Is X connected: call list_integrations with provider set to its name, never the long list. If voice_truncated or page.has_more is true the list is incomplete: say that, never that it is not connected.\n- If the list has ask_workspace: when a request needs more than the listed tools, or you are unsure which tool, say a short "one sec" and call it with a self-contained request, then say the result in your own words. If it says not done yet, handle it as any held call.'

/**
 * "We need X" said on a call is a request for the product, not a limit to work around. Filing it is
 * an ordinary workspace change, so the write gate lets it run at once.
 */
export const VOICE_REQUEST_RULE =
	'- "We need X" or a missing product feature is a request, not a limit: check the records, then file it at once with create_objects as an insight, status new, title starting [Gap], and say so. No workarounds unless asked.'

/**
 * What needs the caller comes from the same ranked list the web For You page shows.
 */
export const VOICE_FOR_YOU_RULE =
	'- To say what needs the caller, call list_for_you with their actor id, not list_notifications. Top card first; due_at today comes first.'

/**
 * Sent as a system message when the call connects, so the agent speaks first. A system item
 * rather than per-response instructions, which would replace the whole briefing for that turn.
 */
export const VOICE_GREETING_INSTRUCTION =
	'The call has just connected. Greet the person by first name, in their language, and in the same breath ask what they want to cover. Keep it to one or two short sentences. Do not call any tool until they answer.'

/** The agent's own prompt was written for text chat; this tells it which style wins on a call. */
export const VOICE_AGENT_PROMPT_NOTE =
	'Written for text chat. On a call, follow the call style above where they differ: short spoken sentences, no markdown, no ids or links read out.'

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

/** The whole briefing for a call: labelled sections, call style first, the agent's own prompt after. */
export function buildVoiceInstructions(input: VoiceInstructionsInput): string {
	const section = (title: string, body: string) => `\n\n# ${title}\n${body}`
	const callerBody = [
		`- ${formatVoiceCallerContext({ callerName: input.caller.name, timezone: input.caller.timezone, now: input.now })}`,
		`- ${formatVoiceCallerRules({ callerName: input.caller.name, callerId: input.caller.id })}`,
		`- Workspace id ${input.workspaceId}: pass it as workspace_id.`,
	].join('\n')
	const prompt = input.systemPrompt?.trim()
	return [
		section('Role and Objective', VOICE_ROLE_RULE),
		section('Personality and Tone', VOICE_PERSONALITY_RULE),
		section('Language', VOICE_LANGUAGE_RULE),
		section('Preambles', VOICE_PREAMBLE_RULE),
		section('Verbosity', VOICE_VERBOSITY_RULE),
		section('Unclear Audio', VOICE_UNCLEAR_AUDIO_RULE),
		section('Caller', callerBody),
		section('Tools', `${VOICE_WRITE_CONFIRMATION}\n${VOICE_CALL_CONDUCT}`),
		section('Drafts and Cards', VOICE_DRAFT_RULE),
		section('Decisions', VOICE_DECISION_RULE),
		section('Requests and For You', `${VOICE_REQUEST_RULE}\n${VOICE_FOR_YOU_RULE}`),
		prompt ? section('Agent', `${VOICE_AGENT_PROMPT_NOTE}\n\n${prompt}`) : '',
		...capVoiceSkills(input.skills, { voiceSessionId: input.voiceSessionId }).map(
			(row) => `\n\n## Skill: ${row.name}\n\n${row.content}`,
		),
		input.chatHistory ? `\n\n${input.chatHistory}` : '',
	]
		.join('')
		.trim()
}
