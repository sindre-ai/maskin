import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { FLAGS, isFlagEnabledForWorkspace } from '../../../feature-flags'
import { findCurrentApproval, withDeliveryState } from '../../../object-delivery'
import { buildObjectPreview } from '../../../object-preview'
import { type SendClosure, recordSendOutcome } from '../../../send-closure'
import { loadApprovedAttachment } from './attachment'
import { LinkedInIntegrationError } from './errors'
import {
	type LinkedInOperationContext,
	replyToLinkedInThread,
	sendLinkedInMessage,
} from './operations'

/**
 * Sends the message an object holds, exactly as a person approved it: the one path that
 * turns the card's Approve into a LinkedIn message, the way `gmail_send_email` does with an
 * `object_id`. `reply` and `send_message` both come through here, so the approval, the
 * once-only rule and the receipt exist once.
 *
 *  - The text is the approved text, read from the object, never taken from the caller, so
 *    what goes out is what the person saw.
 *  - It is refused unless a person approved this exact content (an edit to the text, the
 *    recipient or the attachment withdraws the approval), and refused once it has gone: one
 *    approval, one send. The idempotency key is derived from the approval, so a retry after
 *    a timeout cannot send twice either.
 *  - A conversation (`thread_id` on the object, or from the caller) gets a reply. Without
 *    one, the message starts a chat with `recipient_provider_id` from the object.
 *  - A file (`attachment_file_id` on the object) goes with the message. See attachment.ts.
 *  - On success a `delivered` event is written for the text, which turns the card into a
 *    receipt ("Sent").
 *
 * Sending without an object (a `body` and a `thread_id`, or a `recipient_urn`) is
 * unchanged: this only governs drafts a person was asked to approve.
 */
export async function sendApprovedLinkedInObject(
	ctx: LinkedInOperationContext,
	input: { object_id: string; thread_id?: string },
): Promise<{
	message_id: string
	chat_id?: string
	sent_at: string
	object: { id: string } & SendClosure
}> {
	const [object] = await ctx.db
		.select()
		.from(objects)
		.where(and(eq(objects.id, input.object_id), eq(objects.workspaceId, ctx.workspaceId)))
		.limit(1)
	if (!object) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'That object does not exist here.')
	}

	const preview = buildObjectPreview(object)
	if (preview?.kind !== 'linkedin_message' && preview?.kind !== 'linkedin_inmail') {
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

	if (preview.kind === 'linkedin_inmail') {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'InMail sends are not available yet.')
	}

	const filed = (object.metadata ?? {}) as Record<string, unknown>
	const threadId = input.thread_id ?? optionalString(filed.thread_id)
	const recipient = optionalString(filed.recipient_provider_id)
	if (!threadId && !recipient) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A conversation or a recipient is required: pass thread_id, or file thread_id or recipient_provider_id on the object.',
		)
	}

	const fileId = optionalString(filed.attachment_file_id)
	if (
		fileId &&
		!isFlagEnabledForWorkspace(ctx.workspaceId, FLAGS.LINKEDIN_OUTREACH_ACTIONS, {
			actorId: ctx.actorId,
		})
	) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'Sending a file with a LinkedIn message is not switched on here. Nothing was sent.',
		)
	}
	const attachments = fileId
		? [
				await loadApprovedAttachment(
					{ db: ctx.db, storage: ctx.storage },
					{ workspaceId: ctx.workspaceId, fileId, approvedAt: approval.createdAt },
				),
			]
		: undefined

	// The key an approval's send is claimed under. The events work guards double sends on it.
	const idempotencyKey = `object-${object.id}-${approval.id}`
	const body = { body: preview.body, idempotency_key: idempotencyKey }
	const sent = threadId
		? await replyToLinkedInThread(ctx, { thread_id: threadId, ...body }, { attachments })
		: await sendLinkedInMessage(ctx, { recipient_urn: recipient, ...body }, { attachments })

	// The message is gone: recording it (and closing a task) never throws, so a bookkeeping
	// failure cannot turn into an error the caller retries.
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: {
			content_hash: preview.content_hash,
			message_id: sent.message_id,
			thread_id: threadId ?? sent.chat_id,
		},
	})
	return { ...sent, object: { id: object.id, ...outcome } }
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
