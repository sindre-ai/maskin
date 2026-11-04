import type { Database, Transaction } from '@maskin/db'
import { actors, conversationParticipants, conversations, sessions } from '@maskin/db/schema'
import { buildWebAppHref, resolveWebAppBaseUrl } from '@maskin/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { insertConversationMessage } from './conversation-messages'
import { originConversationOf, resolveHumanBehindSession } from './session-origin'

/**
 * Work a person started in a 1-1 chat answers in that chat. A human @mentioned
 * in an agent's object comment lands in For You; when the commenting session
 * has a chat origin with exactly that human and one agent, the mention is
 * dropped from the stored comment and the text is put in the chat instead. The
 * object comment still posts, as the audit record and for any other mentions.
 *
 * A decision block or attention 4 and above always keeps the mention: those are
 * the "blocked on you" signals. Group chats and sessions without a chat origin
 * (cron, loop, object-started) are untouched.
 */

/** Longest stretch of a comment body copied into the chat. */
export const ROUTED_MESSAGE_MAX_CHARS = 1500

export type SessionOrigin = 'chat' | 'chat_helper' | 'none' | 'no_session'
export type RoutedTo = 'chat' | 'for_you' | 'none'
export type RouteReason =
	| 'routed'
	| 'kept_decision'
	| 'kept_attention'
	| 'kept_group'
	| 'kept_helper'
	| 'no_origin'
	| 'no_human_mention'

export interface CommentRoutingInput {
	workspaceId: string
	commenterId: string
	commenterType: string
	/** X-Maskin-Session-Id: a claim, checked against the commenter below. */
	sessionId: string | undefined
	mentions: string[] | undefined
	hasDecision: boolean
	attention: number | undefined
}

export interface CommentRoutingPlan {
	/** What to store as the comment's mentions: the request's, minus a routed human. */
	storedMentions: string[] | undefined
	/** Set when a human's mention was dropped and the text must go to their chat. */
	delivery: {
		humanId: string
		conversationId: string
		/** The commenting session is the chat session, so its own end-of-turn message follows. */
		ownChat: boolean
	} | null
	sessionOrigin: SessionOrigin
	hasDecisionBlock: boolean
	routedTo: RoutedTo
	routeReason: RouteReason
}

type HeaderSession = Pick<typeof sessions.$inferSelect, 'conversationId' | 'config'>

/** The header session when it is this commenter's own in this workspace, else null. */
async function loadClaimedSession(
	db: Database,
	input: CommentRoutingInput,
): Promise<HeaderSession | null> {
	if (!input.sessionId) return null
	const [row] = await db
		.select({
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			conversationId: sessions.conversationId,
			config: sessions.config,
		})
		.from(sessions)
		.where(eq(sessions.id, input.sessionId))
		.limit(1)
	if (!row || row.actorId !== input.commenterId || row.workspaceId !== input.workspaceId) {
		return null
	}
	return row
}

function classifySession(session: HeaderSession | null): SessionOrigin {
	if (!session) return 'no_session'
	if (session.conversationId) return 'chat'
	return originConversationOf(session) ? 'chat_helper' : 'none'
}

/**
 * Whether `conversationId` is a 1-1 between `humanId` and one agent in this
 * workspace: exactly two active participants. 'missing' covers a chat that does
 * not exist or sits in another workspace.
 */
async function directChatState(
	db: Database,
	args: { conversationId: string; workspaceId: string; humanId: string },
): Promise<'direct' | 'group' | 'missing'> {
	const rows = await db
		.select({
			actorId: conversationParticipants.actorId,
			type: actors.type,
			workspaceId: conversations.workspaceId,
		})
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
		.where(
			and(
				eq(conversationParticipants.conversationId, args.conversationId),
				isNull(conversationParticipants.leftAt),
			),
		)
	if (rows.length === 0 || rows.some((r) => r.workspaceId !== args.workspaceId)) return 'missing'
	const hasHuman = rows.some((r) => r.actorId === args.humanId && r.type === 'human')
	const hasAgent = rows.some((r) => r.type === 'agent')
	return rows.length === 2 && hasHuman && hasAgent ? 'direct' : 'group'
}

/**
 * Decides, for one agent comment, which human mentions go to a chat instead of
 * For You, and classifies the comment for agent_comment_posted. The
 * classification (session_origin, routed_to) is recorded for every comment.
 *
 * A human H is routed only when all hold: the commenter is an agent and the comment has no decision block; attention is absent or
 * below 4; the header session is the commenter's own in this workspace and is
 * the chat's own session (not a helper started from it); that session has a
 * chat origin in this workspace; and the chat has exactly two active
 * participants, H and an agent.
 */
export async function planCommentRouting(
	db: Database,
	input: CommentRoutingInput,
): Promise<CommentRoutingPlan> {
	const plan: CommentRoutingPlan = {
		storedMentions: input.mentions,
		delivery: null,
		sessionOrigin: 'no_session',
		hasDecisionBlock: input.hasDecision,
		routedTo: 'none',
		routeReason: 'no_human_mention',
	}
	if (input.commenterType !== 'agent') return plan

	const session = await loadClaimedSession(db, input)
	plan.sessionOrigin = classifySession(session)

	const mentioned = Array.from(new Set(input.mentions ?? []))
	const humanIds =
		mentioned.length > 0
			? new Set(
					(
						await db
							.select({ id: actors.id })
							.from(actors)
							.where(and(inArray(actors.id, mentioned), eq(actors.type, 'human')))
					).map((a) => a.id),
				)
			: new Set<string>()
	if (humanIds.size === 0) return plan

	const origin = session ? originConversationOf(session) : null
	let firstKept: RouteReason | null = null
	for (const humanId of mentioned) {
		if (!humanIds.has(humanId)) continue
		let kept: RouteReason | null = null
		if (input.hasDecision) kept = 'kept_decision'
		else if (input.attention !== undefined && input.attention >= 4) kept = 'kept_attention'
		// A helper stays in its own thread: its result goes back to the agent that
		// started it, and it reaches the person only by asking (ask_user_question).
		// Copying its comment text into the chat would have it talking in a chat it
		// was never part of.
		else if (plan.sessionOrigin === 'chat_helper') kept = 'kept_helper'
		else if (!origin) kept = 'no_origin'
		else {
			const state = await directChatState(db, {
				conversationId: origin,
				workspaceId: input.workspaceId,
				humanId,
			})
			if (state === 'missing') kept = 'no_origin'
			else if (state === 'group') kept = 'kept_group'
		}
		if (kept === null && origin) {
			// A 1-1 has one human, so at most one mention is ever routed.
			plan.delivery = {
				humanId,
				conversationId: origin,
				ownChat: session?.conversationId === origin,
			}
			break
		}
		firstKept ??= kept
	}

	if (plan.delivery) {
		const routedId = plan.delivery.humanId
		plan.storedMentions = (input.mentions ?? []).filter((id) => id !== routedId)
	}
	const humanStillMentioned = (plan.storedMentions ?? []).some((id) => humanIds.has(id))
	plan.routedTo = humanStillMentioned ? 'for_you' : plan.delivery ? 'chat' : 'none'
	plan.routeReason = plan.delivery ? 'routed' : (firstKept ?? 'no_origin')
	return plan
}

/**
 * Whether a helper started by `senderSessionId` returns to the sender's chat
 * without being asked to (notify_on_complete defaults on). Only when the sender
 * is itself a chat session, the chat is a 1-1 between one person and one agent,
 * and the chat is with that person. A sender with no
 * chat of its own (cron, loop, object-started, a helper) keeps today's default.
 */
export async function returnsToChatByDefault(
	db: Database,
	args: {
		senderSessionId: string
		senderConversationId: string | null
		creatorId: string
		workspaceId: string
	},
): Promise<boolean> {
	if (!args.senderConversationId) return false
	const human = await resolveHumanBehindSession(db, {
		claimedSessionId: args.senderSessionId,
		creatorId: args.creatorId,
		workspaceId: args.workspaceId,
	})
	if (!human.ok) return false
	// Group chats are untouched, as for comments: the walk above names the person
	// who woke the session even in a group, so the chat itself is checked too.
	const chat = await directChatState(db, {
		conversationId: args.senderConversationId,
		workspaceId: args.workspaceId,
		humanId: human.humanId,
	})
	return chat === 'direct'
}

/**
 * Cuts `text` to at most `max` characters at the last paragraph break. A cut
 * that would land inside an open code fence (a chart fence included) moves to
 * before the fence start, so the chat never shows half a fence. With no
 * paragraph break in range it falls back to the last line break, then the last
 * space, then a hard cut.
 */
export function cutAtParagraph(text: string, max: number): { text: string; cut: boolean } {
	if (text.length <= max) return { text, cut: false }
	const window = text.slice(0, max)
	let at = window.lastIndexOf('\n\n')
	if (at <= 0) at = window.lastIndexOf('\n')
	if (at <= 0) at = window.lastIndexOf(' ')
	if (at <= 0) at = max
	const fenceStart = openFenceStart(text.slice(0, at))
	if (fenceStart !== null) at = fenceStart
	return { text: text.slice(0, at).trimEnd(), cut: true }
}

/** Offset of the code fence still open at the end of `prefix`, or null. */
function openFenceStart(prefix: string): number | null {
	let open: number | null = null
	let offset = 0
	for (const line of prefix.split('\n')) {
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) open = open === null ? offset : null
		offset += line.length + 1
	}
	return open
}

function escapeLinkText(title: string): string {
	return title.replace(/[[\]]/g, '')
}

/** The chat message for a routed comment. */
export function buildRoutedMessage(args: {
	body: string
	title: string
	url: string
	/** The commenting session is the chat session: say where, do not repeat the text. */
	pointerOnly: boolean
}): string {
	const link = `[${escapeLinkText(args.title)}](${args.url})`
	if (args.pointerOnly) return `I posted an update on ${link}.`
	const { text, cut } = cutAtParagraph(args.body, ROUTED_MESSAGE_MAX_CHARS)
	if (!cut) return text
	return text ? `${text}\n\nRead the rest: ${link}` : `Read the rest: ${link}`
}

/**
 * Puts a routed comment into its chat as the commenting agent. Goes through
 * insertConversationMessage, never evaluateAndRespond, so it wakes nobody. Run
 * in the same transaction as postComment: the human's mention is already gone
 * from the stored comment, so a message that failed to land would leave them
 * with neither.
 */
export async function deliverRoutedComment(
	db: Database | Transaction,
	args: {
		delivery: NonNullable<CommentRoutingPlan['delivery']>
		workspaceId: string
		commenterId: string
		object: { id: string; title: string; type: string }
		commentEventId: number
		body: string
	},
): Promise<void> {
	const url = buildWebAppHref(resolveWebAppBaseUrl(process.env), args.workspaceId, {
		kind: 'object',
		id: args.object.id,
	})
	const created = await insertConversationMessage(db, {
		conversationId: args.delivery.conversationId,
		workspaceId: args.workspaceId,
		actorId: args.commenterId,
		content: buildRoutedMessage({
			body: args.body,
			title: args.object.title,
			url,
			pointerOnly: args.delivery.ownChat,
		}),
		metadata: {
			delivery: {
				kind: 'routed_comment',
				version: 1,
				object_id: args.object.id,
				comment_event_id: args.commentEventId,
			},
			context_objects: [
				{
					id: args.object.id,
					title: args.object.title.slice(0, 500),
					type: args.object.type.slice(0, 50),
				},
			],
		},
		sessionId: null,
	})
	if (!created) throw new Error('Routed comment message was suppressed')
	logger.info('Comment routed to chat', {
		comment_event_id: args.commentEventId,
		conversation_id: args.delivery.conversationId,
		human_id: args.delivery.humanId,
		commenter_id: args.commenterId,
	})
}
