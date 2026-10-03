import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../../logger'
import type { PostCallContext, PostCallHook } from './post-call'
import { sendFollowup } from './send-followup'

// The call tool the assistant calls only when the prospect explicitly asks for
// the email on the call (Markedsforingsloven section 10(5) carve-out). The tool
// router slice emits it; until it does this hook never sends.
export const FOLLOWUP_REQUEST_TOOL = 'request_followup_email'

// Fixed copy keyed on the outcome status, no LLM: it may only state what the
// status proves.
function callSummaryFor(status: string): string {
	return status === 'voice_meeting_booked'
		? 'Thanks for the call, your meeting is booked.'
		: 'Thanks for taking the time to talk with us today.'
}

function str(v: unknown): string | null {
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

// The Meet link goes out only when the booking was made on the call being emailed:
// a voice_meeting left by an earlier call must never reach this email. The router
// task writes voice_meeting; this hook only reads it.
function meetLinkFor(metadata: Record<string, unknown>, callId: string): string | undefined {
	const meeting = metadata.voice_meeting as
		| { call_id?: unknown; meet_link?: unknown }
		| null
		| undefined
	return meeting?.call_id === callId ? (str(meeting.meet_link) ?? undefined) : undefined
}

async function runFollowupEmail(ctx: PostCallContext): Promise<void> {
	const [row] = await ctx.db
		.select({
			id: objects.id,
			title: objects.title,
			metadata: objects.metadata,
			driver: objects.driver,
			createdBy: objects.createdBy,
		})
		.from(objects)
		.where(
			and(
				eq(objects.id, ctx.contactId),
				eq(objects.workspaceId, ctx.workspaceId),
				eq(objects.type, 'contact'),
			),
		)
		.limit(1)
	if (!row) return

	const metadata = (row.metadata ?? {}) as Record<string, unknown>
	const trace = Array.isArray(metadata.voice_tool_trace) ? metadata.voice_tool_trace : []
	const asked = trace.some(
		(e) => (e as { tool_name?: unknown } | null)?.tool_name === FOLLOWUP_REQUEST_TOOL,
	)
	// Fails closed: no explicit request on this call, no email.
	if (!asked) return

	const skip = (reason: string) =>
		logger.info('voice.email.send_skipped', {
			workspaceId: ctx.workspaceId,
			contactId: ctx.contactId,
			callId: ctx.callId,
			reason,
		})

	// A retried hangup must not send twice: consent_call_id is stamped by sendFollowup after a send.
	if (metadata.consent_call_id === ctx.callId) return skip('already_sent_for_call')

	// Only the address on the contact, never one the model heard on the call.
	const to = str(metadata.email)
	const prospectName = str(metadata.name) ?? str(row.title)
	if (!to || !prospectName) return skip('missing_contact_email_or_name')

	await sendFollowup(ctx.db, {
		workspaceId: ctx.workspaceId,
		contact: { id: row.id, metadata },
		callId: ctx.callId,
		actorId: row.driver ?? row.createdBy,
		to,
		prospectName,
		callSummary: callSummaryFor(ctx.status),
		calendarLink: meetLinkFor(metadata, ctx.callId),
	})
}

export const followupEmailHook: PostCallHook = {
	name: 'followup-email',
	run: runFollowupEmail,
}
