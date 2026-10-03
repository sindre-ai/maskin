import type { Database } from '@maskin/db'
import { logger } from '../../logger'

export interface PostCallContext {
	db: Database
	workspaceId: string
	contactId: string
	callId: string
	/** contact.status after the reducer resolved this hangup. */
	status: string
	hangupCause: string | null
	durationS: number | null
	recordingUrl: string | null
	transcriptUrl: string | null
	/** The hangup payload's inline transcript, when Telnyx sent one. Shape unverified. */
	transcript?: unknown
}

export interface PostCallHook {
	name: string
	run: (ctx: PostCallContext) => Promise<void> | void
}

/**
 * THE seam for post-call work. The call.hangup handler runs this list, in
 * order, after the reducer has resolved the contact's status. Later slices
 * append here and own their hook's behaviour:
 *   1. disclosure assertion (stamps compliance_flag)  - must precede the email
 *   2. S3 mirror of recording + transcript
 *   3. follow-up email
 *   4. PostHog events
 * Ordering is registration order, so a slice that depends on another's output
 * registers after it. Each hook is isolated: one throwing is logged and the
 * rest still run.
 */
export const postCallHooks: PostCallHook[] = []

export async function runPostCallHooks(
	ctx: PostCallContext,
	hooks: readonly PostCallHook[] = postCallHooks,
): Promise<void> {
	for (const hook of hooks) {
		try {
			await hook.run(ctx)
		} catch (err) {
			logger.error('voice post-call hook failed', {
				hook: hook.name,
				callId: ctx.callId,
				contactId: ctx.contactId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}
