import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { DISCLOSURE_PATTERNS } from '../../integrations/providers/telnyx/assistant'
import { logger } from '../../logger'
import { patchContactMetadata } from './apply'
import { type PostCallContext, type PostCallHook, postCallHooks } from './post-call'
import { pingSales } from './sales-ping'

/** Statuses of a call that never reached the agent: nothing was said, so nothing to assert. */
const NOT_CONNECTED = new Set(['voice_no_answer', 'voice_busy', 'voice_voicemail', 'voice_failed'])

const AGENT_ROLES = new Set(['assistant', 'agent', 'ai', 'bot'])

function turnText(turn: Record<string, unknown>): string | null {
	for (const key of ['text', 'content', 'transcript', 'message']) {
		const v = turn[key]
		if (typeof v === 'string' && v.trim() !== '') return v
	}
	return null
}

/**
 * The first thing the agent said, from a transcript shaped as a list of turns with a role and a
 * text. The shape of Telnyx's hangup transcript is not verified against a live call, so this reads
 * the common field names and returns null for anything else.
 */
export function firstAgentUtterance(transcript: unknown): string | null {
	const turns = Array.isArray(transcript)
		? transcript
		: transcript && typeof transcript === 'object'
			? ((transcript as Record<string, unknown>).turns ??
				(transcript as Record<string, unknown>).messages ??
				(transcript as Record<string, unknown>).transcript)
			: null
	if (!Array.isArray(turns)) return null
	for (const turn of turns) {
		if (!turn || typeof turn !== 'object') continue
		const t = turn as Record<string, unknown>
		const role = String(t.role ?? t.speaker ?? '').toLowerCase()
		if (AGENT_ROLES.has(role)) return turnText(t)
	}
	return null
}

export function disclosurePresent(utterance: string | null): boolean {
	return utterance !== null && DISCLOSURE_PATTERNS.some((re) => re.test(utterance))
}

async function fetchTranscript(url: string): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
	if (!res.ok) throw new Error(`transcript fetch failed with ${res.status}`)
	return res.json()
}

/**
 * Belt and braces for the Speak node (tech spec 7a step 4): the first agent utterance must name an
 * AI assistant. Failing, or having no transcript to check on a connected call, stamps
 * compliance_flag = disclosure_missing and pings #sales at Attention 5. The email hook reads the
 * flag and skips. Failing closed on an unreadable transcript is deliberate: a call whose
 * disclosure cannot be shown is treated as one that lacked it.
 */
export function createDisclosureHook(
	getTranscript: (url: string) => Promise<unknown> = fetchTranscript,
): PostCallHook {
	return {
		name: 'disclosure_assertion',
		async run(ctx: PostCallContext) {
			if (NOT_CONNECTED.has(ctx.status) || !ctx.durationS) return

			let transcript: unknown = ctx.transcript ?? null
			if (transcript === null && ctx.transcriptUrl) {
				transcript = await getTranscript(ctx.transcriptUrl).catch((err) => {
					logger.warn('voice transcript fetch failed', {
						callId: ctx.callId,
						error: err instanceof Error ? err.message : String(err),
					})
					return null
				})
			}
			const utterance = firstAgentUtterance(transcript)
			if (disclosurePresent(utterance)) return

			const patched = await patchContactMetadata(ctx.db, {
				workspaceId: ctx.workspaceId,
				contactId: ctx.contactId,
				callId: ctx.callId,
				patch: { compliance_flag: 'disclosure_missing' },
			})
			if (patched !== 'recorded') return
			const [row] = await ctx.db
				.select({ driver: objects.driver, createdBy: objects.createdBy })
				.from(objects)
				.where(eq(objects.id, ctx.contactId))
				.limit(1)
			await pingSales(ctx.db, {
				workspaceId: ctx.workspaceId,
				contactId: ctx.contactId,
				actorId: row?.driver ?? row?.createdBy ?? '',
				attention: 5,
				reason: 'disclosure_missing',
				data: {
					call_id: ctx.callId,
					first_agent_utterance: utterance,
					transcript_available: transcript !== null,
				},
			})
		},
	}
}

/** Warm interest: a Slack-bound ping to #sales at Attention 4 once the recording and transcript exist. */
export const warmInterestHook: PostCallHook = {
	name: 'warm_interest_ping',
	async run(ctx: PostCallContext) {
		const [row] = await ctx.db
			.select({ metadata: objects.metadata, driver: objects.driver, createdBy: objects.createdBy })
			.from(objects)
			.where(and(eq(objects.id, ctx.contactId), eq(objects.workspaceId, ctx.workspaceId)))
			.limit(1)
		const meta = (row?.metadata ?? {}) as Record<string, unknown>
		const interest = meta.voice_interest as
			| { call_id?: string; strength?: string; reason?: string }
			| undefined
		if (interest?.call_id !== ctx.callId || interest.strength !== 'warm') return
		await pingSales(ctx.db, {
			workspaceId: ctx.workspaceId,
			contactId: ctx.contactId,
			actorId: row?.driver ?? row?.createdBy ?? '',
			attention: 4,
			reason: 'warm_interest',
			data: {
				call_id: ctx.callId,
				interest_reason: interest.reason ?? null,
				transcript_url: ctx.transcriptUrl,
				recording_url: ctx.recordingUrl,
				prospect_phone: typeof meta.phone === 'string' ? meta.phone : null,
			},
		})
	},
}

/**
 * Registers this slice's hooks on the shared seam. The disclosure assertion goes first (the email
 * hook reads its flag), whatever order other slices registered in. Safe to call twice.
 */
export function registerVoiceCallHooks(hooks: PostCallHook[] = postCallHooks): void {
	if (!hooks.some((h) => h.name === 'disclosure_assertion')) hooks.unshift(createDisclosureHook())
	if (!hooks.some((h) => h.name === 'warm_interest_ping')) hooks.push(warmInterestHook)
}
