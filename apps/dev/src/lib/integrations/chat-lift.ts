import type { Database, Transaction } from '@maskin/db'
import { events, sessions } from '@maskin/db/schema'
import { and, desc, eq, gt, notInArray, sql } from 'drizzle-orm'
import { TERMINAL_STATUSES } from '../../services/session-lifecycle'

/**
 * "Allow in this chat for 8 hours": a person lets the agent that asked use a connected
 * integration's write tools in one conversation. Only the providers named here can be lifted,
 * and the list is code, not config: widening it means first deciding what a chat-wide Allow
 * gives away for that provider (a provider with an irreversible action needs that gated first).
 *
 * Gmail is here for every write tool except sending: a send is not a gateway tool, it goes through
 * gmail_send_email, which needs a person's approval of the exact text whatever the access level, so
 * a lift does not open it.
 *
 * Not on the list, on purpose: PostHog (one `exec` tool is its whole admin surface), Resend,
 * LinkedIn, Slack, Ubersuggest, custom tool servers. GitHub follows separately.
 */
export const CHAT_LIFT_HOURS = 8
export const CHAT_LIFT_MS = CHAT_LIFT_HOURS * 60 * 60 * 1000

/** What the card says a lift gives. Fixed per provider: never taken from the agent. */
export const CHAT_LIFT_TEXT: Readonly<Record<string, string>> = {
	'google-calendar':
		'Lets this agent change your calendar for 8 hours in this chat. That includes creating, editing and deleting events, and sending invites to attendees. It can still read as before.',
	'google-meet':
		'Lets this agent create Meet spaces and calendar events with a Meet link for 8 hours in this chat. Events with attendees send invites.',
	gmail:
		'Lets this agent create drafts and change labels, and move mail to trash or spam, for 8 hours in this chat. Sending an email still needs its own approval.',
	linear:
		'Lets this agent create, edit and delete Linear issues and comments for 8 hours in this chat.',
}

export function isChatLiftable(provider: string): boolean {
	return Object.hasOwn(CHAT_LIFT_TEXT, provider)
}

export function chatLiftExpiry(now: Date = new Date()): Date {
	return new Date(now.getTime() + CHAT_LIFT_MS)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The chat a tool call comes from, read from the X-Maskin-Session-Id header the session's own
 * MCP entries carry. The header is only a claim: it counts when it names a session of this
 * agent, in this workspace, that has not finished, and that belongs to a conversation.
 * Anything else returns null and the caller gets today's behaviour (no chat lift).
 *
 * The header is the plain session id and is not signed. An agent could name another of its own
 * sessions in a different chat; it can only borrow a grant a person already gave that same
 * agent, for a provider on the list above, and only until it expires.
 */
export async function resolveCallerChat(
	db: Database | Transaction,
	header: string | null | undefined,
	caller: { workspaceId: string; actorId: string },
): Promise<{ sessionId: string; conversationId: string } | null> {
	const sessionId = header?.trim()
	if (!sessionId || !UUID.test(sessionId)) return null
	const [row] = await db
		.select({ id: sessions.id, conversationId: sessions.conversationId })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.workspaceId, caller.workspaceId),
				eq(sessions.actorId, caller.actorId),
				notInArray(sessions.status, [...TERMINAL_STATUSES]),
			),
		)
		.limit(1)
	if (!row?.conversationId) return null
	return { sessionId: row.id, conversationId: row.conversationId }
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/

/**
 * The write tool this agent was last refused on this integration, for the access card to name.
 * It comes from the refused call itself, never from what the agent says, and only counts when
 * the provider really has a tool of that name (the refusal records that) and it is a write.
 * Null when there is no such call in the last half hour: the card then names no tool.
 */
export async function recentRefusedTool(
	db: Database | Transaction,
	input: { workspaceId: string; integrationId: string; actorId: string },
): Promise<string | null> {
	const rows = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.entityType, 'integration'),
				eq(events.entityId, input.integrationId),
				eq(events.actorId, input.actorId),
				eq(events.action, 'agent_access_denied'),
				gt(events.createdAt, sql`now() - interval '30 minutes'`),
			),
		)
		.orderBy(desc(events.id))
		.limit(10)
	for (const { data } of rows) {
		const d = data as { tool?: unknown; kind?: unknown; tool_listed?: unknown } | null
		if (d?.kind === 'write' && d.tool_listed === true && typeof d.tool === 'string') {
			if (TOOL_NAME.test(d.tool)) return d.tool
		}
	}
	return null
}
