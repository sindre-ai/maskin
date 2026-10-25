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
