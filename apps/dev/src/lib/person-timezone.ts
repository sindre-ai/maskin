import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	notificationPreferences,
	sessions,
} from '@maskin/db/schema'
import { isValidTimezone } from '@maskin/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { formatMoment } from '../services/voice-instructions'

/**
 * The zone agents speak in when no person is behind the session (triggers, loops) or the person
 * has none saved. The same zone the agent containers run in (agent-server sets TZ).
 */
export const DEFAULT_AGENT_TIMEZONE = 'Europe/Copenhagen'

/** A person's saved timezone, else the default. Never throws: a bad stored value reads as unset. */
export async function resolvePersonTimezone(
	db: Database,
	actorId: string | null | undefined,
): Promise<string> {
	if (!actorId) return DEFAULT_AGENT_TIMEZONE
	const [row] = await db
		.select({ timezone: notificationPreferences.timezone })
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
		.limit(1)
	const saved = row?.timezone
	return saved && isValidTimezone(saved) ? saved : DEFAULT_AGENT_TIMEZONE
}

/**
 * The person a chat turn is for: its author when that is a person, else the first person still
 * in the chat (an agent's hand-off message still goes back to them). Null when there is none.
 */
export async function findChatPersonId(
	db: Database,
	args: { conversationId: string; authorActorId: string; authorType: string },
): Promise<string | null> {
	if (args.authorType === 'human') return args.authorActorId
	const [row] = await db
		.select({ id: actors.id })
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.where(
			and(
				eq(conversationParticipants.conversationId, args.conversationId),
				isNull(conversationParticipants.leftAt),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(asc(conversationParticipants.joinedAt))
		.limit(1)
	return row?.id ?? null
}

/**
 * The zone for a tool call made inside a session: the person in the session's chat. A session
 * with no chat (a trigger, a loop) or one that is not the caller's gets the default. The session
 * id is only a claim, so the row must belong to the calling agent.
 */
export async function resolveSessionTimezone(
	db: Database,
	args: { sessionId: string; callerActorId: string },
): Promise<string> {
	const [session] = await db
		.select({ conversationId: sessions.conversationId })
		.from(sessions)
		.where(and(eq(sessions.id, args.sessionId), eq(sessions.actorId, args.callerActorId)))
		.limit(1)
	if (!session?.conversationId) return DEFAULT_AGENT_TIMEZONE
	const personId = await findChatPersonId(db, {
		conversationId: session.conversationId,
		authorActorId: args.callerActorId,
		authorType: 'agent',
	})
	return resolvePersonTimezone(db, personId)
}

/** The one line a chat session starts with: the person's local date, time and zone. */
export function formatPersonClockLine(now: Date, timezone: string): string {
	return `It is now ${formatMoment(now, timezone)} (${timezone}) for the person you are talking to. Give every time in that zone, never in UTC unless they ask for it, and for anything less than a day away say "in 15 minutes" or "at 16:30 today". Stored times are UTC: convert them before you say them. This is the time when the session started; for the time later, run: TZ=${timezone} date`
}
