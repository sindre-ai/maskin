import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../../logger'
import { mergeContactMetadata } from './apply'
import { defaultSalesNotifier } from './notify-sales'
import type { PostCallContext, PostCallHook } from './post-call'
import { firstAssistantTurn } from './transcript'

/** Section 7a: the first thing the agent says must disclose that it is an AI. */
export const DISCLOSURE_PATTERNS: readonly RegExp[] = [/AI[- ]?assist/i, /AI[- ]?assistent/i]

export function isDisclosure(utterance: string | null): boolean {
	return utterance !== null && DISCLOSURE_PATTERNS.some((re) => re.test(utterance))
}

/** Only a call that connected and ran has a first utterance to check. */
function wasConnected(ctx: PostCallContext): boolean {
	return ctx.hangupCause?.toLowerCase() === 'normal_clearing' && (ctx.durationS ?? 0) > 0
}

async function loadContact(ctx: PostCallContext) {
	const [row] = await ctx.db
		.select({
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
	return row ?? null
}

/**
 * Belt and braces behind the Speak node (section 7a): asserts the first agent utterance of a
 * connected call matches the AI-assistant phrase. On a miss it stamps
 * metadata.compliance_flag = disclosure_missing, which the follow-up email hook reads, and
 * pings #sales at Attention 5. Fails closed: a connected call whose transcript carries no
 * agent utterance at all is treated as a miss, because disclosure cannot be shown. The
 * transcript shape on the hangup payload is UNVERIFIED against live Telnyx.
 *
 * Must run before the follow-up email hook.
 */
export const disclosureHook: PostCallHook = {
	name: 'disclosure-assertion',
	run: async (ctx) => {
		if (!wasConnected(ctx)) return
		const utterance = firstAssistantTurn(ctx.transcript)
		if (isDisclosure(utterance)) return

		const contact = await loadContact(ctx)
		if (!contact) return
		await mergeContactMetadata(ctx.db, {
			workspaceId: ctx.workspaceId,
			contactId: ctx.contactId,
			patch: { compliance_flag: 'disclosure_missing' },
		})
		await defaultSalesNotifier.notify(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: contact.driver ?? contact.createdBy,
			contactId: ctx.contactId,
			contactTitle: contact.title ?? undefined,
			attention: 5,
			action: 'voice_disclosure_missing_ping',
			text:
				utterance === null
					? 'The AI disclosure could not be confirmed: the call transcript has no agent utterance. The follow-up email is blocked.'
					: 'The agent did not open with the AI disclosure. The follow-up email is blocked.',
			data: { call_id: ctx.callId, first_utterance: utterance },
		})
		logger.error('voice disclosure assertion failed', {
			contactId: ctx.contactId,
			callId: ctx.callId,
			hadUtterance: utterance !== null,
		})
	},
}

/**
 * Warm-lead ping to #sales at Attention 4, sent at hangup because that is when the transcript
 * and recording links exist. Covers a warm flag, and a hot flag whose live transfer did not
 * start (outside the transfer window, no number, or failed). A hot lead whose transfer started
 * is marked ping: not_needed by the router.
 */
export const interestPingHook: PostCallHook = {
	name: 'warm-lead-ping',
	run: async (ctx) => {
		const contact = await loadContact(ctx)
		if (!contact) return
		const interest = (contact.metadata as Record<string, unknown> | null)?.voice_interest as
			| { call_id?: string; strength?: string; reason?: string; ping?: string }
			| undefined
		if (!interest || interest.call_id !== ctx.callId || interest.ping !== 'pending') return

		const phone = ctx.prospectPhone ?? 'unknown'
		await defaultSalesNotifier.notify(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: contact.driver ?? contact.createdBy,
			contactId: ctx.contactId,
			contactTitle: contact.title ?? undefined,
			attention: 4,
			action: 'voice_warm_lead_ping',
			text: `${interest.strength === 'hot' ? 'Hot' : 'Warm'} lead: ${interest.reason ?? 'no reason given'}. Phone: ${phone}. Transcript: ${ctx.transcriptUrl ?? 'not available'}. Recording: ${ctx.recordingUrl ?? 'not available'}.`,
			data: {
				call_id: ctx.callId,
				strength: interest.strength,
				phone,
				transcript_url: ctx.transcriptUrl,
				recording_url: ctx.recordingUrl,
			},
		})
		await mergeContactMetadata(ctx.db, {
			workspaceId: ctx.workspaceId,
			contactId: ctx.contactId,
			patch: { voice_interest: { ...interest, ping: 'sent' } },
		})
	},
}
