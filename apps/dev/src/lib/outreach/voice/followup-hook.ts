import { objects } from '@maskin/db/schema'
import type { VoiceFollowupLanguage } from '@maskin/email'
import { and, eq } from 'drizzle-orm'
import { logger } from '../../logger'
import { checkEmailHookDenyList } from './dnc-gate'
import type { PostCallContext, PostCallHook } from './post-call'
import { sendFollowup } from './send-followup'

// The call tool the assistant calls only when the prospect explicitly asks for
// the email on the call (Markedsforingsloven section 10(1), prior consent). The
// tool router slice emits it; until it does this hook never sends.
export const FOLLOWUP_REQUEST_TOOL = 'request_followup_email'

// Every call in this bet is Danish (+45 numbers, Danish agent), so the email goes
// out in Danish. No per-contact detection until a second market exists.
const FOLLOWUP_LANGUAGE: VoiceFollowupLanguage = 'da'

// Fixed copy keyed on the outcome status, no LLM: it may only state what the
// status proves.
const CALL_SUMMARY: Record<VoiceFollowupLanguage, { booked: string; other: string }> = {
	da: {
		booked: 'Tak for samtalen, dit møde er booket.',
		other: 'Tak fordi du tog dig tid til at tale med os i dag.',
	},
	en: {
		booked: 'Thanks for the call, your meeting is booked.',
		other: 'Thanks for taking the time to talk with us today.',
	},
}

function callSummaryFor(status: string, language: VoiceFollowupLanguage): string {
	const copy = CALL_SUMMARY[language]
	return status === 'voice_meeting_booked' ? copy.booked : copy.other
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
			status: objects.status,
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
	const skip = (reason: string, detail?: Record<string, unknown>) =>
		logger.info('voice.email.send_skipped', {
			workspaceId: ctx.workspaceId,
			contactId: ctx.contactId,
			callId: ctx.callId,
			reason,
			...detail,
		})

	// Suppression check, ahead of the trace gate. This is the shared EMAIL-HOOK deny
	// list (hold, protect, deleted_by_request, rejected), NOT the dialer's generic
	// suppressing set: a prospect who asked for the email ends the call on
	// follow_up_later, which the deny list lets through. Only those four conditions
	// are read, and the reducer never moves a contact into or out of
	// deleted_by_request or rejected, so the post-reducer row is safe to pass.
	const deny = checkEmailHookDenyList({ status: row.status, metadata })
	if (deny.denied)
		return skip('suppressed_by_deny_list', { check: deny.check, detail: deny.reason })

	// Fails closed: no explicit request on this call, no email.
	if (!asked) return skip('no_followup_request')

	// A retried hangup must not send twice: consent_call_id is stamped by sendFollowup after a send.
	if (metadata.consent_call_id === ctx.callId) return skip('already_sent_for_call')

	// One email per contact from this path, no sequence: an earlier send left consent_captured_at.
	if (str(metadata.consent_captured_at)) return skip('already_emailed')

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
		callSummary: callSummaryFor(ctx.status, FOLLOWUP_LANGUAGE),
		language: FOLLOWUP_LANGUAGE,
		calendarLink: meetLinkFor(metadata, ctx.callId),
	})
}

export const followupEmailHook: PostCallHook = {
	name: 'followup-email',
	run: runFollowupEmail,
}
