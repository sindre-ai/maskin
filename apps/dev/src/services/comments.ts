import type { Database } from '@maskin/db'
import { events, actors, notifications, subscriptions } from '@maskin/db/schema'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionManager } from './session-manager'

export interface AppendCommentInput {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	actorId: string
	entityType: string
	entityId: string
	content: string
	mentions?: string[]
	parentEventId?: number
	attachmentFileIds?: string[]
	metadata?: Record<string, unknown>
}

export type AppendedComment = typeof events.$inferSelect

/**
 * Append a `commented` event and run the surrounding fan-out: auto-subscribe
 * the commenter, the thread OP (on replies) and any @-mentioned actors;
 * create needs_input notifications for @-mentioned agents; fire-and-forget
 * spawn agent sessions for the @mention path and any thread-reply auto-spawn
 * candidates. Both the generic `/api/events` comment route and the
 * `/api/conversations/:id/messages` facade call this so chat inherits all the
 * comment-stream machinery without re-implementing it.
 *
 * Caller is responsible for validating that the target entity exists and
 * belongs to `workspaceId` and that any `attachmentFileIds` belong to the
 * workspace — those checks differ between the generic route (object lookup)
 * and the conversation facade (conversation-shaped object lookup +
 * participant check) and are kept out of this helper to avoid duplicating
 * them on the wire.
 */
export async function appendCommentEvent(input: AppendCommentInput): Promise<AppendedComment> {
	const {
		db,
		sessionManager,
		workspaceId,
		actorId,
		entityType,
		entityId,
		content,
		mentions,
		parentEventId: rawParentEventId,
		attachmentFileIds,
		metadata,
	} = input

	// Collapse reply chains to the thread root. The comment model only supports
	// one level of threading, so a reply to a reply must attach to the root
	// instead — otherwise the UI silently drops the comment (it has nowhere to
	// place a child-of-a-child).
	const { parentEventId, opActorId } = await resolveRootParentEventId(
		db,
		workspaceId,
		entityType,
		entityId,
		rawParentEventId,
	)

	const { comment, agentMentions, mentionedSubscriberCount } = await db.transaction(async (tx) => {
		const results = await tx
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'commented',
				entityType,
				entityId,
				data: {
					content,
					mentions,
					parentEventId,
					attachmentFileIds,
					metadata,
				},
			})
			.returning()

		const created = results[0]
		if (!created) {
			throw new Error('Failed to create comment')
		}

		const mentionDispatch: Array<{ agentId: string; notificationId: string }> = []

		if (mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id, type: actors.type, name: actors.name })
				.from(actors)
				.where(inArray(actors.id, mentions))

			const agentActors = mentionedActors.filter((a) => a.type === 'agent')

			if (agentActors.length > 0) {
				const createdNotifications = await tx
					.insert(notifications)
					.values(
						agentActors.map((agent) => ({
							workspaceId,
							type: 'needs_input' as const,
							title: '@mentioned by comment',
							content,
							sourceActorId: actorId,
							targetActorId: agent.id,
							objectId: entityId,
							status: 'pending' as const,
						})),
					)
					.returning()

				if (createdNotifications.length > 0) {
					await tx.insert(events).values(
						createdNotifications.map((notification) => ({
							workspaceId,
							actorId,
							action: 'created',
							entityType: 'notification',
							entityId: notification.id,
							data: notification,
						})),
					)

					for (const notification of createdNotifications) {
						if (notification.targetActorId) {
							mentionDispatch.push({
								agentId: notification.targetActorId,
								notificationId: notification.id,
							})
						}
					}
				}
			}
		}

		// Auto-subscribe the commenter. onConflictDoNothing keeps the existing
		// source so author/manual subscriptions are never downgraded.
		await tx
			.insert(subscriptions)
			.values({
				workspaceId,
				actorId,
				entityType: created.entityType,
				entityId: created.entityId,
				source: 'commenter',
			})
			.onConflictDoNothing({
				target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
			})

		// Auto-subscribe the thread OP when this is a reply.
		if (parentEventId !== undefined && opActorId && opActorId !== actorId) {
			await tx
				.insert(subscriptions)
				.values({
					workspaceId,
					actorId: opActorId,
					entityType: created.entityType,
					entityId: created.entityId,
					source: 'commenter',
				})
				.onConflictDoNothing({
					target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
				})
		}

		// Auto-subscribe @-mentioned actors so the comment reaches their For
		// You page even if they weren't already subscribed.
		let mentionedSubscriberCount = 0
		if (mentions?.length) {
			const uniqueMentioned = Array.from(new Set(mentions)).filter((id) => id !== actorId)
			if (uniqueMentioned.length > 0) {
				await tx
					.insert(subscriptions)
					.values(
						uniqueMentioned.map((mentionedActorId) => ({
							workspaceId,
							actorId: mentionedActorId,
							entityType: created.entityType,
							entityId: created.entityId,
							source: 'mentioned' as const,
						})),
					)
					.onConflictDoNothing({
						target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
					})
				mentionedSubscriberCount = uniqueMentioned.length
			}
		}

		return {
			comment: created,
			agentMentions: mentionDispatch,
			mentionedSubscriberCount,
		}
	})

	if (parentEventId !== undefined && opActorId && opActorId !== actorId) {
		logger.info('Auto-subscribed thread OP to commented object', {
			objectId: entityId,
			commentEventId: comment.id,
			opActorId,
		})
	}

	if (mentionedSubscriberCount > 0) {
		logger.info('Auto-subscribed @-mentioned actors to commented object', {
			objectId: entityId,
			commentEventId: comment.id,
			mentionedSubscriberCount,
		})
	}

	// Fire-and-forget after the tx commits — a failure here doesn't roll back
	// the comment or notifications, and stuck pending sessions are recovered
	// by the watchdog.
	for (const mention of agentMentions) {
		sessionManager
			.createSession(workspaceId, {
				actorId: mention.agentId,
				actionPrompt: buildMentionPrompt({
					objectId: entityId,
					commenterActorId: actorId,
					content,
					notificationId: mention.notificationId,
				}),
				config: {
					mention: {
						object_id: entityId,
						commenter_actor_id: actorId,
						notification_id: mention.notificationId,
						comment_event_id: comment.id,
					},
				},
				createdBy: actorId,
			})
			.catch((err) =>
				logger.error('Failed to create session for @mentioned agent', {
					agentId: mention.agentId,
					objectId: entityId,
					notificationId: mention.notificationId,
					error: String(err),
				}),
			)
	}

	if (parentEventId !== undefined) {
		spawnThreadReplySessions({
			db,
			sessionManager,
			workspaceId,
			actorId,
			entityType,
			entityId,
			threadRootEventId: parentEventId,
			newCommentEventId: comment.id,
			newCommentContent: content,
			excludedAgentIds: new Set(agentMentions.map((m) => m.agentId)),
		}).catch((err) =>
			logger.error('Failed to spawn thread-reply sessions', {
				objectId: entityId,
				threadRootEventId: parentEventId,
				error: String(err),
			}),
		)
	}

	return comment as AppendedComment
}

type ResolvedParent = { parentEventId: number | undefined; opActorId: string | null }

async function resolveRootParentEventId(
	db: Database,
	workspaceId: string,
	entityType: string,
	entityId: string,
	parentEventId: number | undefined,
): Promise<ResolvedParent> {
	if (parentEventId === undefined) return { parentEventId: undefined, opActorId: null }

	const seen = new Set<number>()
	let current: number = parentEventId
	while (!seen.has(current)) {
		seen.add(current)
		const rows: Array<{ id: number; actorId: string; data: unknown }> = await db
			.select({ id: events.id, actorId: events.actorId, data: events.data })
			.from(events)
			.where(
				and(
					eq(events.id, current),
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, entityType),
					eq(events.entityId, entityId),
					eq(events.action, 'commented'),
				),
			)
			.limit(1)
		const parent = rows[0]
		if (!parent) return { parentEventId: undefined, opActorId: null }
		const parentData = parent.data as { parentEventId?: number | null } | null
		const nextId = parentData?.parentEventId
		if (nextId === undefined || nextId === null)
			return { parentEventId: parent.id, opActorId: parent.actorId ?? null }
		current = nextId
	}
	return { parentEventId: undefined, opActorId: null }
}

function buildMentionPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	notificationId: string
}): string {
	return [
		'You were @mentioned in a comment on an object. Read the comment and the object context, then decide what the right response is. The response can be any combination of:',
		'  - taking an action (updating the object, creating related work, running a tool, kicking off another session, etc.)',
		'  - posting a comment reply (to answer, discuss, acknowledge, or report what you did)',
		'  - doing nothing, if no response is warranted',
		'',
		"Let the context guide you — what is being asked explicitly, what's implied by the thread, and what would actually be useful. Action and comment aren't mutually exclusive: it's often right to do the work and post a short comment about it, or to comment first and then act, or just one or the other. Pick whatever genuinely fits.",
		'',
		`Object ID: ${ctx.objectId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'Comment content:',
		'"""',
		ctx.content,
		'"""',
		'',
		`Once you have done whatever you decided to do (including if that's nothing), mark notification ${ctx.notificationId} as resolved.`,
	].join('\n')
}

// Cap on consecutive agent-authored comments at the tail of a thread.
const MAX_CONSECUTIVE_AGENT_REPLIES = 5

// Worst-case bound on recent thread comments to scan when deciding who to
// auto-spawn.
const THREAD_LOOKBACK_LIMIT = 200

async function spawnThreadReplySessions(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	actorId: string
	entityType: string
	entityId: string
	threadRootEventId: number
	newCommentEventId: number
	newCommentContent: string
	excludedAgentIds: Set<string>
}): Promise<void> {
	const threadComments = await ctx.db
		.select({
			id: events.id,
			actorId: events.actorId,
			actorType: actors.type,
			data: events.data,
		})
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				eq(events.workspaceId, ctx.workspaceId),
				eq(events.entityType, ctx.entityType),
				eq(events.entityId, ctx.entityId),
				eq(events.action, 'commented'),
				or(
					eq(events.id, ctx.threadRootEventId),
					sql`${events.data}->>'parentEventId' = ${String(ctx.threadRootEventId)}`,
				),
			),
		)
		.orderBy(desc(events.id))
		.limit(THREAD_LOOKBACK_LIMIT)

	let consecutiveAgents = 0
	for (const row of threadComments) {
		if (row.actorType === 'agent') consecutiveAgents++
		else break
	}
	if (consecutiveAgents >= MAX_CONSECUTIVE_AGENT_REPLIES) {
		logger.info('Skipping thread-reply auto-spawn (consecutive agent cap reached)', {
			objectId: ctx.entityId,
			threadRootEventId: ctx.threadRootEventId,
			consecutiveAgents,
		})
		return
	}

	const agentParticipantIds = new Set<string>()
	const mentionedCandidateIds = new Set<string>()
	for (const row of threadComments) {
		if (row.actorType === 'agent' && row.actorId !== ctx.actorId) {
			agentParticipantIds.add(row.actorId)
		}
		const data = row.data as { mentions?: string[] | null } | null
		if (data?.mentions) {
			for (const id of data.mentions) {
				if (id !== ctx.actorId) mentionedCandidateIds.add(id)
			}
		}
	}

	const toResolve = Array.from(mentionedCandidateIds).filter((id) => !agentParticipantIds.has(id))
	if (toResolve.length > 0) {
		const resolved = await ctx.db
			.select({ id: actors.id, type: actors.type })
			.from(actors)
			.where(inArray(actors.id, toResolve))
		for (const a of resolved) {
			if (a.type === 'agent') agentParticipantIds.add(a.id)
		}
	}

	const threadReplyAgentIds = Array.from(agentParticipantIds).filter(
		(id) => !ctx.excludedAgentIds.has(id),
	)

	for (const agentId of threadReplyAgentIds) {
		ctx.sessionManager
			.createSession(ctx.workspaceId, {
				actorId: agentId,
				actionPrompt: buildThreadReplyPrompt({
					objectId: ctx.entityId,
					commenterActorId: ctx.actorId,
					content: ctx.newCommentContent,
					threadRootEventId: ctx.threadRootEventId,
				}),
				config: {
					thread_reply: {
						object_id: ctx.entityId,
						comment_event_id: ctx.newCommentEventId,
						thread_root_event_id: ctx.threadRootEventId,
						commenter_actor_id: ctx.actorId,
					},
				},
				createdBy: ctx.actorId,
			})
			.catch((err) =>
				logger.error('Failed to create thread-reply session', {
					agentId,
					objectId: ctx.entityId,
					threadRootEventId: ctx.threadRootEventId,
					error: String(err),
				}),
			)
	}
}

function buildThreadReplyPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	threadRootEventId: number
}): string {
	return [
		'A new comment was added to a comment thread you previously participated in. You were NOT @mentioned — you are being notified because you commented or were @mentioned earlier in this thread.',
		'',
		'Read the thread context (use the MCP tools to fetch comments on this object) and assess whether a reply from you adds value. If a reply is helpful, post it as a reply in the same thread. If not, take no action — silence is a valid outcome.',
		'',
		`Object ID: ${ctx.objectId}`,
		`Thread root comment event ID: ${ctx.threadRootEventId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'New comment content:',
		'"""',
		ctx.content,
		'"""',
	].join('\n')
}
