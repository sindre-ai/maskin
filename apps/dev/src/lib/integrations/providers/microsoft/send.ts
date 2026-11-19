import type { Database } from '@maskin/db'
import { recordEvent } from '../../../events/record-event'
import { logger } from '../../../logger'
import { DELIVERED_ACTION } from '../../../object-delivery'
import { recordSendOutcome } from '../../../send-closure'
import { decideSend, deniedMessage } from '../../../send-gate'
import { type Fail, loadApproval, loadObjectEmail } from '../../email-approval'
import { contentHash } from '../gmail/approval-hash'
import type { OutgoingEmail } from '../gmail/send'
import {
	type ApprovalRef,
	approvalSendState,
	claimApprovalForSend,
	settleApprovalSend,
} from '../gmail/send-claim'
import { GraphError, graphPostAction } from './graph'
import { buildSendMailRequest } from './mail'

/**
 * Sending one Outlook message, only after a person approved that exact message. This is the one
 * path in the Microsoft tools that can send mail in a person's name, so it never sends on the
 * agent's word:
 *
 *  - the approval is the same one Gmail uses (email-approval.ts): a person's tap on a decision
 *    card, or their approval of an email object, read back from the log, bound to a fingerprint
 *    of the recipients, subject and body. A changed text no longer matches and is refused;
 *  - one approval sends once: the claim is taken before Graph is called (send-claim.ts);
 *  - Graph is called once and never retried. A refusal (4xx) releases the claim; anything that
 *    may have reached Graph (a gateway error, a timeout) keeps it locked until a person looks in
 *    Sent Items.
 *
 * An agent set to Always allow is held to the same approval: there is no direct send here. Deny
 * refuses outright. Message text is third-party content and never counts as an approval.
 */

export interface SendInput {
	object_id?: string
	approval_comment_id?: number
	draft_id?: string
}

export interface SendDeps {
	db: Database
	workspaceId: string
	actorId: string
	sessionId?: string | null
	integrationId: string
	/** A live Graph token, or the failure to hand back. Called only once the send may go ahead. */
	getToken: () => Promise<{ token: string } | { code: string; message: string }>
	fetchImpl?: typeof fetch
}

export type SendResult =
	| { ok: true; mode: 'approved_draft' }
	| { ok: false; code: string; message: string }
	/** Graph refused it and nothing was sent; the caller words the failure for the agent. */
	| { ok: false; graph: GraphError }

const refused = (f: Fail) => ({
	ok: false as const,
	code: 'NOT_SENT',
	message: [f.body.error.message, f.body.error.suggestion].filter(Boolean).join(' '),
})

const UNKNOWN_OUTCOME_MESSAGE =
	'Outlook may or may not have sent this message. Do not send it again: ask a person to check the Sent Items folder. This approval stays locked until they have.'

export async function sendApprovedMail(deps: SendDeps, input: SendInput): Promise<SendResult> {
	const { db, workspaceId, actorId, integrationId } = deps
	const cardMode = input.approval_comment_id !== undefined
	if (cardMode === (input.object_id !== undefined) || (input.draft_id && !cardMode)) {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message:
				'Pass object_id (an email object a person approved) or approval_comment_id (a card a person answered, with draft_id when the card carries several). Not a mix, and nothing else: the text that is sent is the text the person approved.',
		}
	}

	// The agent's send setting for emails. Deny always refuses. Always allow and Ask first both
	// need a person's approval here.
	const decision = await decideSend(db, {
		workspaceId,
		agentId: actorId,
		kind: 'email',
		sessionId: deps.sessionId,
	})
	if (decision === 'denied') {
		return { ok: false, code: 'SEND_OFF', message: deniedMessage('emails') }
	}

	let email: OutgoingEmail
	let approvalId: number
	let draftObject: { id: string; type: string; hash: string } | null = null
	if (input.object_id) {
		const loaded = await loadObjectEmail(db, undefined, workspaceId, input.object_id, false)
		if ('failure' in loaded) return refused(loaded.failure)
		if (!loaded.approvalEventId) {
			return {
				ok: false,
				code: 'NOT_APPROVED',
				message:
					'Not sent. A person has to approve this exact email first. The draft shows an Approve button in For You and in chat; they can edit the text there first, or just say yes in the chat (then call approve_draft_from_chat). End your turn; when they have approved it, call this tool again with the same object_id.',
			}
		}
		if (loaded.email.attachments?.length) {
			return {
				ok: false,
				code: 'NOT_SENT',
				message: 'Outlook sending does not carry attachments yet. Nothing was sent.',
			}
		}
		email = loaded.email
		approvalId = loaded.approvalEventId
		draftObject = { id: input.object_id, type: loaded.objectType, hash: loaded.contentHash }
	} else {
		const loaded = await loadApproval(
			db,
			workspaceId,
			actorId,
			input.approval_comment_id as number,
			input.draft_id,
			'outlook_send_mail',
		)
		if ('failure' in loaded) return refused(loaded.failure)
		email = loaded.email
		approvalId = input.approval_comment_id as number
	}

	const tokenResult = await deps.getToken()
	if (!('token' in tokenResult)) return { ok: false, ...tokenResult }

	// One send per approval: claim it before Graph is called, so two calls cannot both send.
	const approval: ApprovalRef = {
		workspaceId,
		integrationId,
		provider: 'microsoft',
		actorId,
		approvalCommentId: approvalId,
		...(input.draft_id ? { draftId: input.draft_id } : {}),
	}
	if (!(await claimApprovalForSend(db, approval))) {
		const state = await approvalSendState(db, approval)
		return {
			ok: false,
			code: 'ALREADY_USED',
			message:
				state === 'sent'
					? 'This approval was already used to send an email. Do not send it again.'
					: 'This approval is being used, or a send did not finish cleanly. Do not send it again; ask a person to check the Sent Items folder.',
		}
	}

	const request = buildSendMailRequest(email)
	try {
		await graphPostAction(request.url, tokenResult.token, request.body, {
			fetch: deps.fetchImpl,
		})
	} catch (err) {
		if (err instanceof GraphError && err.status >= 400 && err.status < 500) {
			// Graph refused it, so nothing was sent and the same approval can be used again.
			await settleApprovalSend(db, approval, 'released')
			return { ok: false, graph: err }
		}
		// A gateway error or no answer at all: Graph may have queued it. Locked, never retried.
		await settleApprovalSend(db, approval, 'unknown')
		logger.warn('Outlook send had an unclear outcome', {
			workspaceId,
			status: err instanceof GraphError ? err.status : null,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return { ok: false, code: 'UNKNOWN_OUTCOME', message: UNKNOWN_OUTCOME_MESSAGE }
	}

	const hash = contentHash(email.to, email.cc ?? [], email.subject, email.body)
	try {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: integrationId,
			data: {
				provider: 'microsoft',
				gmail_action: 'sent',
				mode: 'approved_draft',
				content_hash: hash,
				to: email.to
					.map((r) => r.address)
					.join(', ')
					.slice(0, 300),
				recipients: email.to.length + (email.cc?.length ?? 0),
				approval_comment_id: approvalId,
				...(input.draft_id ? { approval_draft_id: input.draft_id } : {}),
				...(draftObject ? { object_id: draftObject.id } : {}),
			},
		})
		// The draft's own log says it went, so its card can turn into a receipt and its task ends.
		if (draftObject) {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: DELIVERED_ACTION,
				entityType: draftObject.type,
				entityId: draftObject.id,
				data: { provider: 'microsoft', content_hash: draftObject.hash, mode: 'approved_draft' },
			})
			await recordSendOutcome(db, {
				workspaceId,
				actorId,
				target: { id: draftObject.id, type: draftObject.type },
				provider: 'microsoft',
				skipDeliveredEvent: true,
			})
		}
	} catch (bookkeepingErr) {
		// The message is gone. Bookkeeping must not turn that into an error the caller retries.
		logger.error('Outlook message sent but the record of it failed', {
			workspaceId,
			error: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
		})
	}
	return { ok: true, mode: 'approved_draft' }
}
