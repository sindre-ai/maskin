import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { logger } from '../../../logger'
import { DELIVERED_ACTION, findCurrentApproval, withDeliveryState } from '../../../object-delivery'
import { buildObjectPreview } from '../../../object-preview'
import { LinkedInIntegrationError } from './errors'
import { type LinkedInOperationContext, replyToLinkedInThread } from './operations'

/**
 * Sends the reply an object holds, exactly as a person approved it: the one path that turns
 * the card's Approve into a LinkedIn message, the way `gmail_send_email` does with an
 * `object_id`.
 *
 *  - The text is the approved text, read from the object, never taken from the caller, so
 *    what goes out is what the person saw.
 *  - It is refused unless a person approved this exact text (an edit withdraws the approval),
 *    and refused once it has gone: one approval, one send. The idempotency key is derived
 *    from the approval, so a retry after a timeout cannot send twice either.
 *  - The conversation comes from `thread_id` on the object, or from the caller when the
 *    agent files it later.
 *  - On success a `delivered` event is written for the text, which turns the card into a
 *    receipt ("Sent").
 *
 * Sending without an object (a `body` and a `thread_id`) is unchanged: this only governs
 * drafts a person was asked to approve.
 */
export async function replyWithApprovedObject(
	ctx: LinkedInOperationContext,
	input: { object_id: string; thread_id?: string },
): Promise<{ message_id: string; chat_id?: string; sent_at: string }> {
	const [object] = await ctx.db
		.select()
		.from(objects)
		.where(and(eq(objects.id, input.object_id), eq(objects.workspaceId, ctx.workspaceId)))
		.limit(1)
	if (!object) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'That object does not exist here.')
	}

	const preview = buildObjectPreview(object)
	if (preview?.kind !== 'linkedin_message') {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'That object is not a LinkedIn message.')
	}
	if (preview.missing.length > 0) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			`The draft is not complete. Missing: ${preview.missing.join(', ')}.`,
		)
	}

	const state = (await withDeliveryState(ctx.db, ctx.workspaceId, object.id, preview)).delivery
		?.state
	if (state === 'sent') {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'This text has already been sent. Do not send it again.',
		)
	}
	const approval = await findCurrentApproval(
		ctx.db,
		ctx.workspaceId,
		object.id,
		preview.content_hash,
	)
	if (!approval) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'No person has approved this text. Do not send. Ask them to approve it from the card (an edit needs approving again), then call this again.',
		)
	}

	const filed = (object.metadata as Record<string, unknown> | null)?.thread_id
	const threadId = input.thread_id ?? (typeof filed === 'string' ? filed : undefined)
	if (!threadId) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'thread_id is required: pass it, or file it on the object as metadata.thread_id.',
		)
	}

	const sent = await replyToLinkedInThread(ctx, {
		thread_id: threadId,
		body: preview.body,
		idempotency_key: `object-${object.id}-${approval.id}`,
	})

	try {
		await recordEvent(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: DELIVERED_ACTION,
			entityType: object.type,
			entityId: object.id,
			data: {
				provider: 'linkedin-unipile',
				content_hash: preview.content_hash,
				message_id: sent.message_id,
				thread_id: threadId,
			},
		})
	} catch (err) {
		// The message is gone. Bookkeeping must not turn that into an error the caller retries.
		logger.error('LinkedIn reply sent but the record of it failed', {
			objectId: object.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return sent
}
