import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { type SendVoiceFollowupEmailParams, sendVoiceFollowupEmail } from '@maskin/email'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { logger } from '../../logger'
import { capturePostCallEmailSent } from './posthog-events'
import { resolveWorkspaceResend } from './resolve-workspace-resend'

export const VOICE_CONSENT_BASIS = 'gdpr_6_1_f_legitimate_interest_b2b_voice'
export const VOICE_DISCLOSED_IDENTITY = 'Maskin ApS, Sebk / Magnus, on behalf of Maskin'

// Written to the contact BEFORE the Resend call and kept after it. It holds the
// id of the call whose email went (or is going) out. Resend accepting a mail and
// the consent_* write landing are two separate steps; this key is the one record
// that survives if the second fails, so a retried hangup cannot send again.
export const VOICE_EMAIL_CLAIM_KEY = 'voice_email_claim'

// The address the opt-out line names and Reply-To points at. The sender
// (noreply plus the receive subdomain) is not read. The reader of this mailbox
// is the inbound Resend trigger that sets the matching voice contact to rejected
// on a stop reply (task: "A stop reply to the opt-out inbox sets the matching
// voice contact to rejected"). Rune's inbox sweep is disabled on purpose and is
// not a reader.
export const VOICE_OPT_OUT_ADDRESS = 'rune@maskin.io'

export type SendFollowupParams = Omit<
	SendVoiceFollowupEmailParams,
	'resend' | 'from' | 'contact' | 'optOutAddress'
> & {
	workspaceId: string
	contact: { id: string; metadata?: Record<string, unknown> | null }
	// Telnyx call the prospect asked for the email on; stored as the consent anchor.
	callId: string
	// Actor recorded on the audit event for the metadata write.
	actorId: string
}

/**
 * Caller-side seam for the post-call email. Resolves the workspace's own
 * Resend identity, then hands pre-resolved values to @maskin/email. The call
 * hangup handling invokes this, never the package directly. A workspace with
 * no usable Resend integration is logged and skipped, not an error.
 *
 * One email per contact, even across a failed write: before calling Resend the
 * contact is claimed with a conditional jsonb merge (VOICE_EMAIL_CLAIM_KEY,
 * only while neither the claim nor consent_captured_at is set), so a replayed
 * hangup finds the claim and sends nothing. The claim is released when Resend
 * rejects the mail or the package skips it, so a failed send never costs the
 * prospect their only email. A process that dies between claim and send leaves
 * the claim in place: that prospect gets no email, never a second one.
 *
 * After a send, the consent_* fields are merged into the contact's metadata
 * (jsonb ||, so sibling keys written by other hangup work survive). This only
 * writes consent_*; the touch timestamps and retention expiry belong to the
 * recordings task.
 */
export async function sendFollowup(db: Database, params: SendFollowupParams): Promise<void> {
	const { workspaceId, callId, actorId, ...email } = params
	const resolved = await resolveWorkspaceResend(db, workspaceId)
	if (!resolved) {
		logger.info('voice.email.send_skipped', {
			workspaceId,
			reason: 'no_resend_integration',
		})
		return
	}

	const claimed = await db
		.update(objects)
		.set({
			metadata: sql`COALESCE(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify({ [VOICE_EMAIL_CLAIM_KEY]: callId })}::jsonb`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(objects.id, email.contact.id),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
				sql`COALESCE(${objects.metadata}, '{}'::jsonb)->>${VOICE_EMAIL_CLAIM_KEY}::text IS NULL`,
				sql`COALESCE(${objects.metadata}, '{}'::jsonb)->>'consent_captured_at' IS NULL`,
			),
		)
		.returning({ id: objects.id })
	if (claimed.length === 0) {
		logger.info('voice.email.send_skipped', {
			workspaceId,
			contactId: email.contact.id,
			callId,
			reason: 'already_claimed',
		})
		return
	}

	let result: Awaited<ReturnType<typeof sendVoiceFollowupEmail>>
	try {
		result = await sendVoiceFollowupEmail({
			...email,
			...resolved,
			optOutAddress: VOICE_OPT_OUT_ADDRESS,
		})
	} catch (err) {
		await releaseClaim(db, workspaceId, email.contact.id, callId)
		throw err
	}
	if (!result.sent) {
		await releaseClaim(db, workspaceId, email.contact.id, callId)
		return
	}
	// Only here: every skip above returns first, so the event means an email actually went out.
	capturePostCallEmailSent(email.contact.id)

	const patch = {
		consent_basis: VOICE_CONSENT_BASIS,
		consent_call_id: callId,
		consent_disclosed_identity: VOICE_DISCLOSED_IDENTITY,
		consent_captured_at: new Date().toISOString(),
	}
	await db
		.update(objects)
		.set({
			metadata: sql`COALESCE(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(objects.id, email.contact.id),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
			),
		)
	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'object',
		entityId: email.contact.id,
		data: { metadata: patch },
	})
}

// Undo the claim after a send that did not leave the process. Only removes the
// claim this call made. A failed release is logged, not thrown: the caller is
// already propagating the send error, and a stuck claim only fails safe (no
// email), never double.
async function releaseClaim(
	db: Database,
	workspaceId: string,
	contactId: string,
	callId: string,
): Promise<void> {
	try {
		await db
			.update(objects)
			.set({
				metadata: sql`${objects.metadata} - ${VOICE_EMAIL_CLAIM_KEY}::text`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(objects.id, contactId),
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'contact'),
					sql`${objects.metadata}->>${VOICE_EMAIL_CLAIM_KEY}::text = ${callId}`,
				),
			)
	} catch (err) {
		logger.error('voice.email.claim_release_failed', {
			workspaceId,
			contactId,
			callId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
