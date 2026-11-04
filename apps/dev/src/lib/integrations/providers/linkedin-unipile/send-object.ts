import { files, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { findCurrentApproval, withDeliveryState } from '../../../object-delivery'
import { buildObjectPreview } from '../../../object-preview'
import { type SendClosure, recordSendOutcome } from '../../../send-closure'
import { loadApprovedAttachment } from './attachment'
import { LinkedInIntegrationError } from './errors'
import { assertInmailSendable, readCreditsAfter, startInmailChat } from './inmail-send'
import {
	type CommentResult,
	type EditPostResult,
	type LinkedInOperationContext,
	type PublishPostResult,
	commentOnLinkedInPost,
	editLinkedInPost,
	publishLinkedInPost,
	replyToLinkedInComment,
	replyToLinkedInThread,
	sendLinkedInConnectionRequest,
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
 *  - An InMail (`linkedin_inmail`) only goes through `send_inmail`, which passes `inmail`: the
 *    flag is checked first, then the same approval, then the 1st-degree and credit rules
 *    (inmail-send.ts), then the chat is started as an InMail under the key
 *    `inmail-{object_id}-{approval_id}`, and the credits are read once more after the send.
 *  - On success a `delivered` event is written for the text, which turns the card into a
 *    receipt ("Sent").
 *
 * Sending without an object (a `body` and a `thread_id`, or a `recipient_urn`) is
 * unchanged: this only governs drafts a person was asked to approve.
 */
export async function sendApprovedLinkedInObject(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		thread_id?: string
		/**
		 * Called once the draft is approved and its recipient is known, before anything is sent. The
		 * action log uses it to record who the message goes to and which approval released it.
		 */
		onResolved?: (resolved: { targetProviderId?: string; approvalId: string }) => void
		/**
		 * Set only by `send_inmail`. Gets the classic credits right before and after the send, for
		 * the action log.
		 */
		inmail?: {
			onCredits: (credits: { credits_before: number; credits_after: number | null }) => void
		}
	},
): Promise<{
	message_id: string
	chat_id?: string
	sent_at: string
	credits_before?: number
	credits_after?: number | null
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
	// The two kinds never swap tools: an InMail spends a credit and has its own rules, and a
	// plain message sent through send_inmail would be one.
	if (input.inmail && preview.kind !== 'linkedin_inmail') {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'That object is not an InMail draft. Send a plain LinkedIn message with send_message or reply.',
		)
	}
	if (!input.inmail && preview.kind === 'linkedin_inmail') {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'An InMail draft is sent with send_inmail, not with send_message or reply.',
		)
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

	const filed = (object.metadata ?? {}) as Record<string, unknown>
	// An InMail always opens a new chat, so a conversation on the object or the call is ignored.
	const threadId = input.inmail ? undefined : (input.thread_id ?? optionalString(filed.thread_id))
	const recipient = optionalString(filed.recipient_provider_id)
	if (!threadId && !recipient) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A conversation or a recipient is required: pass thread_id, or file thread_id or recipient_provider_id on the object.',
		)
	}

	input.onResolved?.({
		targetProviderId: threadId ? undefined : recipient,
		approvalId: String(approval.id),
	})

	const fileId = optionalString(filed.attachment_file_id)
	const attachments = fileId
		? [
				await loadApprovedAttachment(
					{ db: ctx.db, storage: ctx.storage },
					{ workspaceId: ctx.workspaceId, fileId, approvedAt: approval.createdAt },
				),
			]
		: undefined

	if (input.inmail && recipient) {
		const creditsBefore = await assertInmailSendable(ctx, recipient)
		const sent = await startInmailChat(
			ctx,
			{
				recipient_urn: recipient,
				body: preview.body,
				idempotency_key: `inmail-${object.id}-${approval.id}`,
			},
			{ attachments },
		)
		const creditsAfter = await readCreditsAfter(ctx)
		input.inmail.onCredits({ credits_before: creditsBefore, credits_after: creditsAfter })
		const outcome = await recordSendOutcome(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			target: { id: object.id, type: object.type, status: object.status },
			provider: 'linkedin-unipile',
			data: {
				content_hash: preview.content_hash,
				message_id: sent.message_id,
				thread_id: sent.chat_id,
			},
		})
		return {
			...sent,
			credits_before: creditsBefore,
			credits_after: creditsAfter,
			object: { id: object.id, ...outcome },
		}
	}

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

/**
 * The object a held send carries out, once it is known to be a complete draft of the wanted
 * kind that a person approved and that has not gone yet. The same checks and the same
 * messages as `sendApprovedLinkedInObject`, for the sends that are not messages.
 */
async function loadApprovedDraft(
	ctx: LinkedInOperationContext,
	objectId: string,
	want: { kind: string; notIt: string },
) {
	const [object] = await ctx.db
		.select()
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, ctx.workspaceId)))
		.limit(1)
	if (!object) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'That object does not exist here.')
	}
	const preview = buildObjectPreview(object)
	if (preview?.kind !== want.kind) {
		throw new LinkedInIntegrationError('INVALID_INPUT', want.notIt)
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
	return { object, preview, approval, filed: (object.metadata ?? {}) as Record<string, unknown> }
}

/**
 * Sends the connection invitation an object holds, exactly as a person approved it: the
 * person is `recipient_provider_id` on the object and the note is its text, never taken from
 * the caller. Refused until a person approved this exact content, and once it has gone.
 *
 * `beforeSend` runs after the draft is approved and before the invitation goes out, with the
 * person it is for: the re-invite lock after a withdrawal is checked there.
 */
export async function sendApprovedLinkedInConnectionRequest(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		onResolved?: (resolved: { targetProviderId: string; approvalId: string }) => void
		beforeSend?: (targetProviderId: string) => Promise<void>
	},
): Promise<{
	status: 'sent'
	sent_at: string
	invitation_id?: string
	object: { id: string } & SendClosure
}> {
	const { object, preview, approval, filed } = await loadApprovedDraft(ctx, input.object_id, {
		kind: 'linkedin_connection_request',
		notIt: 'That object is not a LinkedIn connection request.',
	})
	const recipient = optionalString(filed.recipient_provider_id)
	if (!recipient) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A recipient is required: file recipient_provider_id on the object.',
		)
	}
	input.onResolved?.({ targetProviderId: recipient, approvalId: String(approval.id) })
	await input.beforeSend?.(recipient)

	const sent = await sendLinkedInConnectionRequest(ctx, {
		user_id: recipient,
		message: preview.body,
	})
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: {
			content_hash: preview.content_hash,
			invitation_id: sent.invitation_id,
			sent_at: sent.sent_at,
		},
	})
	return { ...sent, object: { id: object.id, ...outcome } }
}

/**
 * Publishes the post an object holds, exactly as a person approved it: the text is the post
 * body on the object and the images are the files listed in its `attachment_file_ids`, never
 * taken from the caller. Refused until a person approved this exact content, and once it has
 * gone. An image file saved again after the approval is refused, since an approval covers the
 * file id and not what the file holds.
 */
export async function publishApprovedLinkedInPost(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		onResolved?: (resolved: { approvalId: string }) => void
	},
): Promise<PublishPostResult & { replayed: boolean; object: { id: string } & SendClosure }> {
	const { object, preview, approval, filed } = await loadApprovedDraft(ctx, input.object_id, {
		kind: 'linkedin_post',
		notIt: 'That object is not a LinkedIn post.',
	})
	const fileIds = (optionalString(filed.attachment_file_ids) ?? '')
		.split(/[\s,]+/)
		.filter((id) => id.length > 0)
	for (const fileId of fileIds) {
		const [file] = await ctx.db
			.select({ updatedAt: files.updatedAt })
			.from(files)
			.where(and(eq(files.id, fileId), eq(files.workspaceId, ctx.workspaceId)))
			.limit(1)
		// A file that is not here fails in the post itself, with its id. An approval with no
		// time cannot show the file is unchanged, so it does not pass.
		if (file && (!approval.createdAt || file.updatedAt.getTime() > approval.createdAt.getTime())) {
			throw new LinkedInIntegrationError(
				'INVALID_INPUT',
				`File ${fileId} changed after it was approved. Ask a person to approve it again.`,
			)
		}
	}
	input.onResolved?.({ approvalId: String(approval.id) })

	const published = await publishLinkedInPost(ctx, {
		text: preview.body,
		...(fileIds.length > 0 ? { attachment_file_ids: fileIds } : {}),
	})
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: { content_hash: preview.content_hash, post_id: published.post_id },
	})
	return { ...published, object: { id: object.id, ...outcome } }
}

/**
 * Posts the comment an object holds, exactly as a person approved it: the text is the
 * object's text and the post is `post_id` on the object, never taken from the caller. Refused
 * until a person approved this exact content (an edit to the text or the post withdraws it),
 * and once it has gone.
 */
export async function commentOnApprovedLinkedInPost(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		onResolved?: (resolved: { approvalId: string }) => void
	},
): Promise<CommentResult & { replayed: boolean; object: { id: string } & SendClosure }> {
	const { object, preview, approval, filed } = await loadApprovedDraft(ctx, input.object_id, {
		kind: 'linkedin_comment',
		notIt: 'That object is not a LinkedIn comment.',
	})
	const postId = optionalString(filed.post_id)
	if (!postId) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A post is required: file post_id on the object.',
		)
	}
	input.onResolved?.({ approvalId: String(approval.id) })

	const posted = await commentOnLinkedInPost(ctx, { post_id: postId, text: preview.body })
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: { content_hash: preview.content_hash, post_id: postId, comment_id: posted.comment_id },
	})
	return { ...posted, object: { id: object.id, ...outcome } }
}

/**
 * Replies to the comment an object names, exactly as a person approved it: the text is the
 * object's text and the comment answered is `comment_id` on the object, never taken from the
 * caller. `post_id` is filed too, so the card says which post the exchange is on and an edit
 * to it withdraws the approval. Refused until a person approved this exact content, and once
 * it has gone.
 */
export async function replyToApprovedLinkedInComment(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		onResolved?: (resolved: { approvalId: string }) => void
	},
): Promise<CommentResult & { replayed: boolean; object: { id: string } & SendClosure }> {
	const { object, preview, approval, filed } = await loadApprovedDraft(ctx, input.object_id, {
		kind: 'linkedin_comment_reply',
		notIt: 'That object is not a LinkedIn comment reply.',
	})
	const commentId = optionalString(filed.comment_id)
	if (!commentId || !optionalString(filed.post_id)) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A post and a comment are required: file post_id and comment_id on the object.',
		)
	}
	input.onResolved?.({ approvalId: String(approval.id) })

	const posted = await replyToLinkedInComment(ctx, { comment_id: commentId, text: preview.body })
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: {
			content_hash: preview.content_hash,
			comment_id: commentId,
			reply_id: posted.comment_id,
		},
	})
	return { ...posted, object: { id: object.id, ...outcome } }
}

/**
 * Edits the post an object names to the text it holds, exactly as a person approved it: the
 * new text is the object's text and the post is `post_id` on the object, never taken from the
 * caller. Only the text changes: who may comment is not part of a held edit. Refused until a
 * person approved this exact content, and once it has gone.
 */
export async function editApprovedLinkedInPost(
	ctx: LinkedInOperationContext,
	input: {
		object_id: string
		onResolved?: (resolved: { approvalId: string }) => void
	},
): Promise<EditPostResult & { replayed: boolean; object: { id: string } & SendClosure }> {
	const { object, preview, approval, filed } = await loadApprovedDraft(ctx, input.object_id, {
		kind: 'linkedin_post_edit',
		notIt: 'That object is not a LinkedIn post edit.',
	})
	const postId = optionalString(filed.post_id)
	if (!postId) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'A post is required: file post_id on the object.',
		)
	}
	input.onResolved?.({ approvalId: String(approval.id) })

	const edited = await editLinkedInPost(ctx, { post_id: postId, text: preview.body })
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target: { id: object.id, type: object.type, status: object.status },
		provider: 'linkedin-unipile',
		data: { content_hash: preview.content_hash, post_id: postId, edited_at: edited.edited_at },
	})
	return { ...edited, object: { id: object.id, ...outcome } }
}
