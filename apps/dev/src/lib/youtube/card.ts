import type { Database, Transaction } from '@maskin/db'
import type { youtubePendingActions } from '@maskin/db/schema'
import type { CommentDecision } from '@maskin/shared'
import { postComment } from '../comments'
import { sortKeys } from './hash'
import { describeStoredRequest } from './upload'

/**
 * The For You card for one pending YouTube action, drawn from the stored row. Nothing here reads
 * what the agent wrote except `agentNote`, which goes in its own labelled place and never takes
 * the payload's. The same function draws the card when the action is made and again each time the
 * list is read, so the card always shows what the row holds.
 */

export const YOUTUBE_APPROVE_LABEL = 'Approve'
export const YOUTUBE_REJECT_LABEL = 'Reject'

export type ActionCardSource = Pick<
	typeof youtubePendingActions.$inferSelect,
	'kind' | 'payload' | 'payloadHash' | 'targetVideoId' | 'channelLabel' | 'agentNote' | 'expiresAt'
>

const KIND_PHRASES: Record<string, string> = {
	update_video_metadata: 'edit the details of a video',
	set_thumbnail: 'set the thumbnail of a video',
	create_playlist: 'create a playlist',
	add_to_playlist: 'add a video to a playlist',
	post_comment: 'post a comment',
	reply_to_comment: 'reply to a comment',
	like: 'like a video or a comment',
	upload_video: 'upload a video as private',
	publish_video: 'change who can watch a video',
}

const APPROVE_CONSEQUENCES: Record<string, [string, string]> = {
	upload_video: [
		'The video uploads to YouTube as private',
		'Nobody can watch it until a second approval',
	],
	publish_video: [
		'The video changes visibility on YouTube',
		'Viewers can see it once it is public',
	],
}

const DRAFT_LABEL = 'YouTube change'
const NOTE_LABEL = "Agent's note (written by the agent, not checked)"

/** The exact request, as a person reads it before choosing. */
export function renderActionBody(action: ActionCardSource): string {
	const lines = [
		`Action: ${KIND_PHRASES[action.kind] ?? action.kind}`,
		`Channel: ${action.channelLabel ?? 'the connected channel'}`,
		...(action.targetVideoId
			? [`Video: https://www.youtube.com/watch?v=${encodeURIComponent(action.targetVideoId)}`]
			: []),
		// Read from the stored request, like the JSON below, never from what the agent wrote.
		...describeStoredRequest(action.kind, (action.payload ?? {}) as Record<string, unknown>),
		'Request:',
		JSON.stringify(sortKeys(action.payload ?? {}), null, 2),
	]
	return lines.join('\n')
}

export function renderYoutubeActionCard(action: ActionCardSource): {
	content: string
	decision: CommentDecision
} {
	const channel = action.channelLabel ?? 'the connected channel'
	const phrase = KIND_PHRASES[action.kind] ?? 'make a change'
	return {
		content: action.agentNote
			? `A YouTube change is waiting for approval.\n\n${NOTE_LABEL}: ${action.agentNote}`
			: 'A YouTube change is waiting for approval.',
		decision: {
			title: 'Approve this YouTube change?',
			summary: `An agent asked to ${phrase} on ${channel}. Nothing is sent until you say yes.`,
			options: [
				{
					label: YOUTUBE_APPROVE_LABEL,
					destructive: true,
					consequences: APPROVE_CONSEQUENCES[action.kind] ?? [
						'The change goes to YouTube right away',
						'Viewers can see it',
					],
				},
				{
					label: YOUTUBE_REJECT_LABEL,
					recommended: true,
					consequences: ['Nothing is sent to YouTube', 'The agent has to ask again'],
				},
			],
			draft: { label: DRAFT_LABEL, to: channel, body: renderActionBody(action) },
			expires_at: action.expiresAt.toISOString(),
			// The card lives as long as the action does, whatever its object does meanwhile.
			keep_on_status_change: true,
		},
	}
}

/**
 * Posts the card as the agent that asked and returns its event id. Not routed through
 * `POST /api/events`, so no agent can post one of these: the action id on the event is written
 * here and nowhere else.
 */
export async function postYoutubeActionCard(
	tx: Database | Transaction,
	params: {
		action: ActionCardSource & { id: string; workspaceId: string }
		entityId: string
		authorId: string
		approverIds: string[]
	},
): Promise<number> {
	const { content, decision } = renderYoutubeActionCard(params.action)
	const { comment } = await postComment(tx, {
		workspaceId: params.action.workspaceId,
		actorId: params.authorId,
		entityId: params.entityId,
		content,
		mentions: params.approverIds,
		decision,
		attention: 4,
		youtubeActionId: params.action.id,
		youtubePayloadHash: params.action.payloadHash,
	})
	return Number(comment.id)
}
