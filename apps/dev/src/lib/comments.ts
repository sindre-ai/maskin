import type { Database } from '@maskin/db'
import { events, actors, subscriptions } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'
import { insertNotificationsWithEvents } from './notifications'

export interface AgentMention {
	agentId: string
	notificationId: string
}

export interface PostCommentInput {
	workspaceId: string
	actorId: string
	entityId: string
	entityType?: string
	content: string
	mentions?: string[]
	parentEventId?: number
	attachmentFileIds?: string[]
	metadata?: unknown
	attention?: number
}

export interface PostCommentResult {
	comment: typeof events.$inferSelect
	agentMentions: AgentMention[]
	/**
	 * Mention ids from the request that matched no row in `actors`. Callers
	 * surface these back to the client — an agent posting over MCP typically
	 * transcribed a UUID out of its system prompt and fumbled a character, and
	 * silently dropping the mention means the human it was trying to reach is
	 * never notified.
	 */
	unresolvedMentions: string[]
}

/**
 * Core comment-creation logic: insert the `commented` event, notify
 * @mentioned agents, and auto-subscribe the commenter + mentions. Shared by
 * `POST /api/events` and any backend code that needs to post a comment
 * programmatically (e.g. the signup-welcome onboarding step in
 * `lib/onboarding/signup-welcome.ts`) — both need identical mention/
 * notification/subscription semantics so a mention triggers an agent session
 * regardless of whether the comment came from the HTTP route or from server
 * code.
 *
 * Does NOT spawn agent sessions for `agentMentions` — callers do that after
 * this resolves, since the action prompt differs per caller.
 */
export async function postComment(
	db: Database,
	input: PostCommentInput,
): Promise<PostCommentResult> {
	const entityType = input.entityType ?? 'object'

	return db.transaction(async (tx) => {
		const results = await tx
			.insert(events)
			.values({
				workspaceId: input.workspaceId,
				actorId: input.actorId,
				action: 'commented',
				entityType,
				entityId: input.entityId,
				data: {
					content: input.content,
					mentions: input.mentions,
					parentEventId: input.parentEventId,
					attachmentFileIds: input.attachmentFileIds,
					metadata: input.metadata,
					attention: input.attention,
				},
			})
			.returning()

		const comment = results[0]
		if (!comment) {
			throw new Error('Failed to create comment')
		}

		const agentMentions: AgentMention[] = []

		// Mention ids come straight off the request body, so they can reference
		// actors that never existed or were deleted since the client rendered the
		// composer. Resolve them against `actors` once and use the resolved set for
		// both notifications and subscriptions — inserting an unknown id into
		// `subscriptions.actor_id` violates its FK and aborts the whole comment.
		let existingMentionedIds: string[] = []
		let unresolvedMentions: string[] = []

		if (input.mentions?.length) {
			const mentionedActors = await tx
				.select({ id: actors.id, type: actors.type })
				.from(actors)
				.where(inArray(actors.id, input.mentions))

			existingMentionedIds = mentionedActors.map((a) => a.id)
			const existingSet = new Set(existingMentionedIds)
			unresolvedMentions = Array.from(new Set(input.mentions)).filter((id) => !existingSet.has(id))

			const agentActors = mentionedActors.filter((a) => a.type === 'agent')

			if (agentActors.length > 0) {
				const createdNotifications = await insertNotificationsWithEvents(tx, {
					workspaceId: input.workspaceId,
					actorId: input.actorId,
					rows: agentActors.map((agent) => ({
						workspaceId: input.workspaceId,
						type: 'needs_input' as const,
						title: '@mentioned by comment',
						content: input.content,
						sourceActorId: input.actorId,
						targetActorId: agent.id,
						objectId: input.entityId,
						status: 'pending' as const,
					})),
				})

				for (const notification of createdNotifications) {
					if (notification.targetActorId) {
						agentMentions.push({
							agentId: notification.targetActorId,
							notificationId: notification.id,
						})
					}
				}
			}
		}

		// Auto-subscribe the commenter — anyone who comments on an entity starts
		// watching it for future activity (Slack-channel-style). On conflict we
		// keep the existing source so author/manual subscriptions are never
		// downgraded to 'commenter'.
		await tx
			.insert(subscriptions)
			.values({
				workspaceId: input.workspaceId,
				actorId: input.actorId,
				entityType,
				entityId: input.entityId,
				source: 'commenter',
			})
			.onConflictDoNothing({
				target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
			})

		// Auto-subscribe @-mentioned actors so the comment reaches their For You
		// page even if they weren't already subscribed.
		if (existingMentionedIds.length > 0) {
			const uniqueMentioned = Array.from(new Set(existingMentionedIds)).filter(
				(id) => id !== input.actorId,
			)
			if (uniqueMentioned.length > 0) {
				await tx
					.insert(subscriptions)
					.values(
						uniqueMentioned.map((mentionedActorId) => ({
							workspaceId: input.workspaceId,
							actorId: mentionedActorId,
							entityType,
							entityId: input.entityId,
							source: 'mentioned' as const,
						})),
					)
					.onConflictDoNothing({
						target: [subscriptions.actorId, subscriptions.entityType, subscriptions.entityId],
					})
			}
		}

		return { comment, agentMentions, unresolvedMentions }
	})
}
