import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { findCurrentApproval, withDeliveryState } from '../../../object-delivery'
import { buildObjectPreview } from '../../../object-preview'
import { type SendClosure, recordSendOutcome } from '../../../send-closure'

/**
 * Slack posts that go out without a person's approval: a short built-in list of internal
 * channels, by Slack id. Everything else (every DM, every customer or shared channel) is held
 * for approval. Today that is #development only, so the pages that tell a person the merge
 * seat or main is red still reach them. A per-channel allowlist is a separate task.
 */
export const DIRECT_POST_CHANNEL_IDS: ReadonlySet<string> = new Set(['C06LC37JJCS'])

export const SLACK_MESSAGE_KIND = 'slack_message'

/** Thrown for a refusal the agent can act on. The message is shown to the agent as written. */
export class SlackSendRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SlackSendRefusal'
	}
}

/** The refusal for a call with a channel and text and no approved draft. */
export const DIRECT_POST_HELD_MESSAGE =
	'Direct Slack posts are held for a person to approve. Nothing was posted. Save the message as a task whose content is only the exact text, with metadata.kind slack_message and metadata.channel (for example #coach-maskin). Ask a person to approve it with a decision card whose draft.object_id is that task. Once they approve, call slack_send_message again with object_id set to that task. Do not retry with channel and text.'

/** The refusal for an edit with a channel and text and no approved draft. */
export const DIRECT_EDIT_HELD_MESSAGE =
	'Editing a Slack message is held for a person to approve, because it changes what people read under the bot name. Nothing was changed. Save the new text as a task whose content is only the exact text, with metadata.kind slack_message and metadata.channel (the channel the message is in). Ask a person to approve it with a decision card whose draft.object_id is that task. Once they approve, call slack_update_message again with object_id set to that task and ts set to the message to edit. Do not retry with channel and text.'

/** True when a post to this channel id may go without approval. */
export function isDirectPostChannel(channelId: string): boolean {
	return DIRECT_POST_CHANNEL_IDS.has(channelId)
}

/**
 * The draft behind an approved send, once it is known to be a complete `slack_message` that a
 * person approved and that has not gone yet. Same checks as the LinkedIn and Gmail send paths:
 *  - the text and channel come from the object, never from the caller, so what goes out is
 *    what the person saw,
 *  - an edit to the text or the channel changes the content hash and withdraws the approval,
 *  - a draft that has been sent is refused: one approval, one send.
 */
export async function loadApprovedSlackMessage(
	db: Database,
	params: { workspaceId: string; objectId: string },
) {
	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, params.objectId), eq(objects.workspaceId, params.workspaceId)))
		.limit(1)
	if (!object) {
		throw new SlackSendRefusal('That object does not exist here. Nothing was posted.')
	}

	const preview = buildObjectPreview(object)
	if (preview?.kind !== SLACK_MESSAGE_KIND) {
		throw new SlackSendRefusal(
			'That object is not a Slack message draft (metadata.kind slack_message). Nothing was posted.',
		)
	}
	if (preview.missing.length > 0) {
		throw new SlackSendRefusal(
			`The draft is not complete. Missing: ${preview.missing.join(', ')}. Nothing was posted.`,
		)
	}

	const state = (await withDeliveryState(db, params.workspaceId, object.id, preview)).delivery
		?.state
	if (state === 'sent') {
		throw new SlackSendRefusal('This text has already been posted. Do not post it again.')
	}
	const approval = await findCurrentApproval(
		db,
		params.workspaceId,
		object.id,
		preview.content_hash,
	)
	if (!approval) {
		throw new SlackSendRefusal(
			'No person has approved this text. Nothing was posted. Ask them to approve it from the card (an edit needs approving again), then call this again.',
		)
	}

	const channel = preview.details.find((d) => d.label === 'Channel')?.value.trim()
	if (!channel) {
		throw new SlackSendRefusal('The draft has no channel. Nothing was posted.')
	}
	return { object, preview, approval, channel }
}

/** Writes the receipt for a post that went out. Never throws: the message is already gone. */
export function recordSlackPost(
	db: Database,
	params: {
		workspaceId: string
		actorId: string
		object: { id: string; type: string; status: string }
		contentHash: string
		channel: string
		ts?: string
	},
): Promise<SendClosure> {
	return recordSendOutcome(db, {
		workspaceId: params.workspaceId,
		actorId: params.actorId,
		target: params.object,
		provider: 'slack',
		data: { content_hash: params.contentHash, channel: params.channel, ts: params.ts },
	})
}
