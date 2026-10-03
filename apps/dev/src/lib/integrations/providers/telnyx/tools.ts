import type { Database } from '@maskin/db'
import { actors, objects } from '@maskin/db/schema'
import { z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { logger } from '../../../logger'
import { type RecordedContact, recordToolCall } from '../../../outreach/voice/apply'
import { type SalesNotifier, defaultSalesNotifier } from '../../../outreach/voice/notify-sales'
import { type Slot, findSlots, searchRange } from '../../../outreach/voice/slots'
import { copenhagenParts } from '../../../outreach/voice/workdays'
import { type CalendarApi, resolveCalendarApi } from '../google-calendar/client'
import { type TelnyxClient, createTelnyxClient } from './client'
import { readTelnyxRuntimeConfig } from './config'
import type { ToolHandler, ToolInvocationContext } from './tool-dispatch'

export const TOOL_NAMES = [
	'book_meeting_slot',
	'confirm_meeting_slot',
	'flag_interest',
	'send_followup_sms',
	'end_call_polite',
	'request_followup_email',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const MEETING_TIME_ZONE = 'Europe/Copenhagen'
/** Telnyx raises call.transfer.failed when the transfer leg has not answered after this long. */
export const TRANSFER_RING_TIMEOUT_SECS = 15
const DEFAULT_TRANSFER_HOURS = { startMinutes: 10 * 60, endMinutes: 15 * 60 }
const E164 = /^\+[1-9]\d{6,14}$/

const text = (max: number) => z.string().trim().min(1).max(max)

// ---- Inputs ----------------------------------------------------------------

export const bookMeetingSlotInput = z.object({
	prospect_email: text(254),
	prospect_name: text(120),
	/** Free text from the prospect ("next week", "mornings"); recorded, not interpreted. */
	preferred_window: text(120).optional(),
})

export const confirmMeetingSlotInput = z.object({
	/** The number of the option read out, 1 to 3. */
	slot_index: z.number().int().min(1).max(3),
	prospect_email: text(254),
	prospect_name: text(120),
})

export const flagInterestInput = z.object({
	strength: z.enum(['warm', 'hot']),
	reason: text(500),
})

export const sendFollowupSmsInput = z.object({
	message_body: text(320),
	mode: z.enum(['booking_link', 'voicemail_followup', 'missed_call_nudge']),
})

export const endCallPoliteInput = z.object({
	reason: text(300),
})

export const toolInputSchemas = {
	book_meeting_slot: bookMeetingSlotInput,
	confirm_meeting_slot: confirmMeetingSlotInput,
	flag_interest: flagInterestInput,
	send_followup_sms: sendFollowupSmsInput,
	end_call_polite: endCallPoliteInput,
} as const

// ---- Outputs ---------------------------------------------------------------

export const toolErrorOutput = z.object({
	error: z.enum([
		'invalid_input',
		'calendar_unavailable',
		'no_slots_offered',
		'tool_not_callable',
		'no_sms_endpoints',
		'contact_not_found',
	]),
	message: z.string(),
})
export type ToolError = z.infer<typeof toolErrorOutput>

const slotSchema = z.object({ start_iso: z.string(), end_iso: z.string() })
const acknowledged = z.object({ acknowledged: z.literal(true) })

export const toolOutputSchemas = {
	book_meeting_slot: z.union([z.object({ slots: z.array(slotSchema).min(1).max(3) }), toolErrorOutput]),
	confirm_meeting_slot: z.union([
		z.object({ event_id: z.string(), meet_link: z.string().nullable() }),
		toolErrorOutput,
	]),
	flag_interest: z.union([acknowledged, toolErrorOutput]),
	send_followup_sms: z.union([z.object({ message_id: z.string().nullable() }), toolErrorOutput]),
	end_call_polite: z.union([acknowledged, toolErrorOutput]),
} as const

// ---- Dependencies ----------------------------------------------------------

export interface ToolRouterDeps {
	now: () => Date
	/** The workspace's Calendar client, or null when none is connected. */
	calendar: (db: Database, workspaceId: string) => Promise<CalendarApi | null>
	telnyx: () => TelnyxClient | null
	notifier: SalesNotifier
	/** Runs work that must not hold up the tool answer (a transfer). Errors are logged by the caller. */
	defer: (work: Promise<unknown>) => void
}

function runtimeTelnyxClient(): TelnyxClient | null {
	const { apiKey, apiBaseUrl } = readTelnyxRuntimeConfig()
	return apiKey ? createTelnyxClient({ apiKey, baseUrl: apiBaseUrl }) : null
}

export const defaultToolRouterDeps: ToolRouterDeps = {
	now: () => new Date(),
	calendar: resolveCalendarApi,
	telnyx: () => runtimeTelnyxClient(),
	notifier: defaultSalesNotifier,
	defer: (work) => {
		work.catch((err) =>
			logger.error('voice deferred tool work failed', {
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	},
}

// ---- Helpers ---------------------------------------------------------------

function fail(error: ToolError['error'], message: string): ToolError {
	return { error, message }
}

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

function invalidInput(err: z.ZodError): ToolError {
	return fail(
		'invalid_input',
		err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
	)
}

async function loadContact(
	db: Database,
	ctx: ToolInvocationContext,
): Promise<RecordedContact | null> {
	const [row] = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.id, ctx.clientState.contact_id),
				eq(objects.workspaceId, ctx.clientState.workspace_id),
				eq(objects.type, 'contact'),
			),
		)
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		title: row.title ?? '',
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		actorId: row.driver ?? row.createdBy,
	}
}

function record(
	ctx: ToolInvocationContext,
	toolName: string | null,
	extra: {
		metadataPatch?: Record<string, unknown>
		once?: boolean
		inTransaction?: Parameters<typeof recordToolCall>[1]['inTransaction']
	} = {},
) {
	return recordToolCall(ctx.db, {
		workspaceId: ctx.clientState.workspace_id,
		contactId: ctx.clientState.contact_id,
		callId: ctx.callId,
		toolName,
		...extra,
	})
}

const CALENDAR_FAILURE_MESSAGE =
	'The booking did not go through. Tell the prospect the booking did not go through and stop there. Do not promise an email, a text or a call-back.'

/** Strict calendar fallback (errata section 7): stamp the internal hint, promise nothing. */
async function calendarFailure(ctx: ToolInvocationContext, cause: unknown): Promise<ToolError> {
	logger.warn('voice calendar call failed', {
		contactId: ctx.clientState.contact_id,
		callId: ctx.callId,
		error: cause instanceof Error ? cause.message : String(cause),
	})
	await record(ctx, null, { metadataPatch: { followup_action: 'email_calendar_link' } })
	return fail('calendar_unavailable', CALENDAR_FAILURE_MESSAGE)
}

// ---- Tools -----------------------------------------------------------------

async function bookMeetingSlot(
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<typeof bookMeetingSlotInput>,
) {
	// A malformed address is a calendar failure, not a Zod rejection (spec section 3).
	if (!isEmail(input.prospect_email)) {
		return calendarFailure(ctx, new Error('prospect email is malformed'))
	}
	let slots: Slot[]
	try {
		const calendar = await deps.calendar(ctx.db, ctx.clientState.workspace_id)
		if (!calendar) throw new Error('no active google-calendar integration')
		const now = deps.now()
		const range = searchRange(now)
		slots = findSlots(await calendar.freeBusy(range.timeMin.toISOString(), range.timeMax.toISOString()), now)
		if (slots.length === 0) throw new Error('no free slot in the search window')
	} catch (err) {
		return calendarFailure(ctx, err)
	}

	const recorded = await record(ctx, 'book_meeting_slot', {
		metadataPatch: {
			voice_offered_slots: { call_id: ctx.callId, offered_at: deps.now().toISOString(), slots },
			...(input.preferred_window ? { voice_preferred_window: input.preferred_window } : {}),
		},
	})
	if (!recorded.recorded) return fail('contact_not_found', 'This call is not tied to a contact.')
	return { slots }
}

function offeredSlots(contact: RecordedContact, callId: string): Slot[] {
	const offered = contact.metadata.voice_offered_slots as
		| { call_id?: unknown; slots?: unknown }
		| undefined
	if (!offered || offered.call_id !== callId || !Array.isArray(offered.slots)) return []
	return offered.slots as Slot[]
}

async function confirmMeetingSlot(
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<typeof confirmMeetingSlotInput>,
) {
	const contact = await loadContact(ctx.db, ctx)
	if (!contact) return fail('contact_not_found', 'This call is not tied to a contact.')

	// Telnyx retries a slow tool call: a booking already made on this call is returned, not repeated.
	const existing = contact.metadata.voice_booking as
		| { call_id?: string; event_id?: string; meet_link?: string | null }
		| undefined
	if (existing?.call_id === ctx.callId && existing.event_id) {
		return { event_id: existing.event_id, meet_link: existing.meet_link ?? null }
	}

	const slot = offeredSlots(contact, ctx.callId)[input.slot_index - 1]
	if (!slot) {
		return fail('no_slots_offered', 'Call book_meeting_slot first, then confirm one of its options.')
	}
	if (!isEmail(input.prospect_email)) {
		return calendarFailure(ctx, new Error('prospect email is malformed'))
	}

	let booked: { eventId: string; meetLink: string | null }
	try {
		const calendar = await deps.calendar(ctx.db, ctx.clientState.workspace_id)
		if (!calendar) throw new Error('no active google-calendar integration')
		booked = await calendar.insertEvent({
			summary: `Maskin intro call: ${input.prospect_name}`,
			startIso: slot.start_iso,
			endIso: slot.end_iso,
			timeZone: MEETING_TIME_ZONE,
			attendee: { email: input.prospect_email, displayName: input.prospect_name },
			requestId: `maskin-${contact.id}-${ctx.callId}`.replace(/[^A-Za-z0-9_-]/g, '-'),
		})
	} catch (err) {
		return calendarFailure(ctx, err)
	}

	await record(ctx, 'confirm_meeting_slot', {
		once: true,
		metadataPatch: {
			voice_booking: {
				call_id: ctx.callId,
				event_id: booked.eventId,
				meet_link: booked.meetLink,
				start_iso: slot.start_iso,
			},
			// A successful booking supersedes an earlier failure hint on this call.
			followup_action: null,
		},
	})
	return { event_id: booked.eventId, meet_link: booked.meetLink }
}

function parseTransferHours(raw: unknown): { startMinutes: number; endMinutes: number } {
	const match = typeof raw === 'string' ? /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim()) : null
	if (!match) return DEFAULT_TRANSFER_HOURS
	const startMinutes = Number(match[1]) * 60 + Number(match[2])
	const endMinutes = Number(match[3]) * 60 + Number(match[4])
	return startMinutes < endMinutes && endMinutes <= 24 * 60
		? { startMinutes, endMinutes }
		: DEFAULT_TRANSFER_HOURS
}

function sipHeaderValue(value: string): string {
	// SIP header values are one line of printable ASCII.
	return value.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Live warm transfer for a hot lead. Returns 'started' when Telnyx accepted the transfer,
 * 'skipped' when it was not attempted (no target, outside the window, no number), and
 * posts to #sales at Attention 3 when starting it failed. The agent falls back to booking
 * either way (prompt), so this never throws into the call.
 */
async function attemptTransfer(
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	contact: RecordedContact,
	reason: string,
): Promise<'started' | 'skipped'> {
	const targetId = contact.metadata.transfer_target_actor_id
	if (typeof targetId !== 'string') return 'skipped'
	const [target] = await ctx.db
		.select({ metadata: actors.metadata, name: actors.name })
		.from(actors)
		.where(eq(actors.id, targetId))
		.limit(1)
	const targetMeta = (target?.metadata ?? {}) as Record<string, unknown>
	const phone = targetMeta.transfer_phone_e164
	if (typeof phone !== 'string' || !E164.test(phone)) return 'skipped'

	const hours = parseTransferHours(targetMeta.transfer_hours)
	const local = copenhagenParts(deps.now())
	const minutes = local.hour * 60 + local.minute
	if (minutes < hours.startMinutes || minutes >= hours.endMinutes) return 'skipped'

	const client = deps.telnyx()
	try {
		if (!client) throw new Error('TELNYX_API_KEY is not configured')
		await client.transferCall(ctx.callId, {
			to: phone,
			from: ctx.from,
			timeoutSecs: TRANSFER_RING_TIMEOUT_SECS,
			customHeaders: [
				{ name: 'X-Maskin-Summary', value: sipHeaderValue(`${contact.title}: ${reason}`) },
			],
		})
		return 'started'
	} catch (err) {
		logger.error('voice warm transfer failed to start', {
			contactId: contact.id,
			error: err instanceof Error ? err.message : String(err),
		})
		await deps.notifier.notify(ctx.db, {
			workspaceId: ctx.clientState.workspace_id,
			actorId: contact.actorId,
			contactId: contact.id,
			contactTitle: contact.title,
			attention: 3,
			action: 'voice_transfer_failed_ping',
			text: `Warm transfer could not be started. The agent is booking a slot instead. Reason given: ${reason}`,
			data: { call_id: ctx.callId, stage: 'start' },
		})
		return 'skipped'
	}
}

async function flagInterest(
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<typeof flagInterestInput>,
) {
	const contact = await loadContact(ctx.db, ctx)
	if (!contact) return fail('contact_not_found', 'This call is not tied to a contact.')

	// A retried flag of the same strength on this call changes nothing and transfers nothing twice.
	const prior = contact.metadata.voice_interest as
		| { call_id?: string; strength?: string }
		| undefined
	if (prior?.call_id === ctx.callId && prior.strength === input.strength) {
		return { acknowledged: true as const }
	}

	// Every flag is pinged to #sales at hangup, when the transcript and recording links exist,
	// except a hot lead whose live transfer actually started (cleared below).
	const recorded = await record(ctx, 'flag_interest', {
		metadataPatch: {
			voice_interest: {
				call_id: ctx.callId,
				strength: input.strength,
				reason: input.reason,
				flagged_at: deps.now().toISOString(),
				ping: 'pending',
			},
		},
	})
	if (!recorded.recorded) return fail('contact_not_found', 'This call is not tied to a contact.')

	if (input.strength === 'hot') {
		deps.defer(
			attemptTransfer(deps, ctx, recorded.contact, input.reason).then(async (outcome) => {
				if (outcome !== 'started') return
				await record(ctx, null, {
					metadataPatch: {
						voice_interest: {
							...(recorded.contact.metadata.voice_interest as Record<string, unknown>),
							ping: 'not_needed',
						},
					},
				})
			}),
		)
	}
	return { acknowledged: true as const }
}

async function sendFollowupSms(
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<typeof sendFollowupSmsInput>,
) {
	if (input.mode !== 'booking_link') {
		return fail(
			'tool_not_callable',
			'Only booking_link can be sent from a call. The other modes are sent by the system.',
		)
	}
	const contact = await loadContact(ctx.db, ctx)
	if (!contact) return fail('contact_not_found', 'This call is not tied to a contact.')

	const sent = contact.metadata.voice_sms as { call_id?: string; message_id?: string | null } | undefined
	if (sent?.call_id === ctx.callId) return { message_id: sent.message_id ?? null }

	const client = deps.telnyx()
	if (!client || !ctx.from || !ctx.to) {
		return fail('no_sms_endpoints', 'The text could not be sent. Do not promise it to the prospect.')
	}
	const result = await client.sendMessage({
		from: ctx.from,
		to: ctx.to,
		text: input.message_body,
		idempotencyKey: `${contact.id}:${ctx.callId}:booking_link`,
	})
	await record(ctx, 'send_followup_sms', {
		once: true,
		metadataPatch: {
			last_voice_sms_id: result.messageId,
			voice_sms: { call_id: ctx.callId, message_id: result.messageId, mode: 'booking_link' },
		},
	})
	return { message_id: result.messageId }
}

async function endCallPolite(
	_deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<typeof endCallPoliteInput>,
) {
	const recorded = await record(ctx, 'end_call_polite', {
		metadataPatch: { voice_end_reason: input.reason },
	})
	if (!recorded.recorded) return fail('contact_not_found', 'This call is not tied to a contact.')
	return { acknowledged: true as const }
}

// ---- Router ----------------------------------------------------------------

type Handler<S extends z.ZodTypeAny> = (
	deps: ToolRouterDeps,
	ctx: ToolInvocationContext,
	input: z.infer<S>,
) => Promise<unknown>

function entry<N extends keyof typeof toolInputSchemas>(
	name: N,
	handler: Handler<(typeof toolInputSchemas)[N]>,
) {
	return { name, input: toolInputSchemas[name], output: toolOutputSchemas[name], handler }
}

const routes = [
	entry('book_meeting_slot', bookMeetingSlot),
	entry('confirm_meeting_slot', confirmMeetingSlot),
	entry('flag_interest', flagInterest),
	entry('send_followup_sms', sendFollowupSms),
	entry('end_call_polite', endCallPolite),
] as const

/**
 * The tool router: one switch keyed on tool_name, Zod on the way in and out. It answers in
 * the webhook's 200 body, so a bad input is an error object the model can read and recover
 * from, not an HTTP error. A tool name it does not own (Telnyx's own retrieval tool) is
 * acknowledged and left alone. A throw is an infrastructure fault: the webhook releases the
 * claim and Telnyx retries, so every tool here is safe to run twice for one invocation.
 */
export function createToolRouter(overrides: Partial<ToolRouterDeps> = {}): ToolHandler {
	const deps: ToolRouterDeps = { ...defaultToolRouterDeps, ...overrides }
	return async (ctx) => {
		const route = routes.find((r) => r.name === ctx.toolName)
		if (!route) return { ok: true, handled: false }

		const parsed = route.input.safeParse(ctx.toolInput)
		if (!parsed.success) return invalidInput(parsed.error)

		const result = await (route.handler as Handler<z.ZodTypeAny>)(deps, ctx, parsed.data)
		return route.output.parse(result)
	}
}
