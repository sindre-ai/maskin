import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { findCurrentApproval, withDeliveryState } from '../../../object-delivery'
import { buildObjectPreview } from '../../../object-preview'
import { type SendClosure, recordSendOutcome } from '../../../send-closure'

export const SLACK_MESSAGE_KIND = 'slack_message'

/** Thrown for a refusal the agent can act on. The message is shown to the agent as written. */
export class SlackSendRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SlackSendRefusal'
	}
}

/**
 * The draft behind a send, once it is known to be a complete `slack_message` that has not gone
 * yet. For an agent set to ask first (`requireApproval`, the default) a person must also have
 * approved it. Same checks as the LinkedIn and Gmail send paths:
 *  - the text and channel come from the object, never from the caller, so what goes out is
 *    what the person saw,
 *  - an edit to the text or the channel changes the content hash and withdraws the approval,
 *  - a draft that has been sent is refused: one approval, one send.
 * An agent set to always allow may pass a draft too (to have the send recorded on it); then no
 * approval is needed and the other checks still hold.
 */
export async function loadApprovedSlackMessage(
	db: Database,
	params: { workspaceId: string; objectId: string; requireApproval?: boolean },
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
	if (!approval && params.requireApproval !== false) {
		throw new SlackSendRefusal(
			'No person has approved this text. Nothing was posted. Ask them to approve it from the card, or to say yes in the chat (an edit needs approving again), then call this again.',
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
