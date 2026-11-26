import type { Database, Transaction } from '@maskin/db'
import type { youtubePendingActions } from '@maskin/db/schema'
import type { CommentDecision } from '@maskin/shared'
import { postComment } from '../comments'
import { sortKeys } from './hash'
import { describeStoredRequest, uploadVisibilityWord } from './upload'

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
	moderate_comment: 'change the moderation status of a comment',
	upload_video: 'upload a video',
	publish_video: 'change who can watch a video',
	upload_caption: 'add a caption track to a video',
	replace_caption: 'replace a caption track of a video',
	delete_caption: 'delete a caption track of a video',
	delete_video: 'PERMANENTLY DELETE a video',
	delete_comment: 'delete a comment',
	delete_playlist: 'delete a playlist',
	remove_from_playlist: 'remove a video from a playlist',
}

const KIND_TITLES: Record<string, string> = {
	delete_video: 'PERMANENTLY delete this video and its comments?',
}

const APPROVE_CONSEQUENCES: Record<string, string[]> = {
	moderate_comment: [
		'The comment changes status on YouTube',
		'Rejected comments are hidden from viewers',
	],
	publish_video: [
		'The video changes visibility on YouTube',
		'Viewers can see it once it is public',
	],
	upload_caption: ['The caption file goes to YouTube right away', 'Viewers can turn it on'],
	replace_caption: [
		'The caption track on YouTube is overwritten with the new file',
		'The old text cannot be brought back from here',
	],
	delete_caption: [
		'The caption track is removed from the video on YouTube',
		'It cannot be brought back from here',
	],
	delete_video: [
		'The video is deleted from YouTube for good',
		'It cannot be restored',
		'Its comments and statistics go with it',
	],
	delete_comment: ['The comment is removed from YouTube', 'It cannot be restored'],
	delete_playlist: ['The playlist is deleted from YouTube', 'The videos in it stay on the channel'],
	remove_from_playlist: ['The video leaves the playlist', 'The video itself stays on the channel'],
}

/** What approving an upload does, read from the stored request: its visibility is the one that is sent. */
function uploadConsequences(payload: Record<string, unknown>): [string, string] {
	switch (uploadVisibilityWord(payload)) {
		case 'PUBLIC':
			return [
				'The video uploads to YouTube as PUBLIC',
				'Everyone can watch it once YouTube has processed it',
			]
		case 'UNLISTED':
			return [
				'The video uploads to YouTube as UNLISTED',
				'Anyone with the link can watch it once YouTube has processed it',
			]
		case 'SCHEDULED':
			return [
				'The video uploads to YouTube as private',
				`It becomes PUBLIC at ${String(payload.publishAt)} (UTC)`,
			]
		default:
			return [
				'The video uploads to YouTube as private',
				'Nobody can watch it until a second approval',
			]
	}
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
	const payload = (action.payload ?? {}) as Record<string, unknown>
	const phrase =
		action.kind === 'upload_video'
			? `upload a video (visibility ${uploadVisibilityWord(payload)})`
			: (KIND_PHRASES[action.kind] ?? 'make a change')
	return {
		content: action.agentNote
			? `A YouTube change is waiting for approval.\n\n${NOTE_LABEL}: ${action.agentNote}`
			: 'A YouTube change is waiting for approval.',
		decision: {
			title: KIND_TITLES[action.kind] ?? 'Approve this YouTube change?',
			summary: `An agent asked to ${phrase} on ${channel}. Nothing is sent until you say yes.`,
			options: [
				{
					label: YOUTUBE_APPROVE_LABEL,
					destructive: true,
					consequences:
						action.kind === 'upload_video'
							? uploadConsequences(payload)
							: (APPROVE_CONSEQUENCES[action.kind] ?? [
									'The change goes to YouTube right away',
									'Viewers can see it',
								]),
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
