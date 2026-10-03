import type { Database } from '@maskin/db'
import { type SendVoiceFollowupEmailParams, sendVoiceFollowupEmail } from '@maskin/email'
import { logger } from '../../logger'
import { resolveWorkspaceResend } from './resolve-workspace-resend'

export type SendFollowupParams = Omit<SendVoiceFollowupEmailParams, 'resend' | 'from'> & {
	workspaceId: string
}

/**
 * Caller-side seam for the post-call email. Resolves the workspace's own
 * Resend identity, then hands pre-resolved values to @maskin/email. The call
 * hangup handling invokes this, never the package directly. A workspace with
 * no usable Resend integration is logged and skipped, not an error.
 */
export async function sendFollowup(db: Database, params: SendFollowupParams): Promise<void> {
	const { workspaceId, ...email } = params
	const resolved = await resolveWorkspaceResend(db, workspaceId)
	if (!resolved) {
		logger.info('voice.email.send_skipped', {
			workspaceId,
			reason: 'no_resend_integration',
		})
		return
	}
	await sendVoiceFollowupEmail({ ...email, ...resolved })
}
