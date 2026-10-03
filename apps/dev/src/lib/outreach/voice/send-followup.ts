import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { type SendVoiceFollowupEmailParams, sendVoiceFollowupEmail } from '@maskin/email'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { logger } from '../../logger'
import { resolveWorkspaceResend } from './resolve-workspace-resend'

export const VOICE_CONSENT_BASIS = 'gdpr_6_1_f_legitimate_interest_b2b_voice'
export const VOICE_DISCLOSED_IDENTITY = 'Maskin ApS, Sebk / Magnus, on behalf of Maskin'

// The address the opt-out line names and Reply-To points at. The sender
// (noreply plus the receive subdomain) is not read: no trigger acts on inbound
// resend.email events. Rune's inbox triage scans this mailbox.
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
	const result = await sendVoiceFollowupEmail({
		...email,
		...resolved,
		optOutAddress: VOICE_OPT_OUT_ADDRESS,
	})
	if (!result.sent) return

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
