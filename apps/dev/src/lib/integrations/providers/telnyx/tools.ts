import type { Database } from '@maskin/db'
import { actors, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { ZodTypeAny, z } from 'zod'
import { logger } from '../../../logger'
import { patchContactMetadata, recordToolSuccess } from '../../../outreach/voice/apply'
import { type FounderActors, parseFounderActors } from '../../../outreach/voice/dnc-gate'
import { pingSales } from '../../../outreach/voice/sales-ping'
import { proposeSlots, slotSearchRange } from '../../../outreach/voice/slots'
import { copenhagenParts } from '../../../outreach/voice/workdays'
import {
	type CalendarClient,
	calendarEventId,
	createCalendarClient,
	getCalendarAccessToken,
} from '../google-calendar/calendar-client'
import { currentScriptVersion } from './assistant'
import { type TelnyxClient, createTelnyxClient } from './client'
import { readTelnyxRuntimeConfig } from './config'
import { type ToolHandler, type ToolInvocationContext, registerToolHandler } from './tool-dispatch'
import {
	DECLARED_TOOL_NAMES,
	DISABLED_TOOL_NAMES,
	E164_RE,
	type ToolError,
	acknowledgedOutput,
	bookMeetingSlotInput,
	bookMeetingSlotOutput,
	confirmMeetingSlotInput,
	confirmMeetingSlotOutput,
	endCallPoliteInput,
	flagInterestInput,
	requestFollowupEmailInput,
} from './tool-schemas'

/** Telnyx waits this long for the transfer target to answer; past it the transfer has failed. */
export const TRANSFER_TIMEOUT_SECS = 15
export const DEFAULT_TRANSFER_HOURS = '10:00-15:00'

export interface ToolRouterDeps {
	now: () => Date
	/** Null when the workspace has no usable Google Calendar connection. */
	calendarFor: (db: Database, workspaceId: string) => Promise<CalendarClient | null>
	telnyx: () => TelnyxClient | null
	/** Owner slug to human actor id: the same VOICE_FOUNDER_ACTORS map the dialer uses. */
	founders: () => FounderActors
	/**
	 * The agent's last turn before the prospect's yes, from Telnyx's own record of the call. None of
	 * the Telnyx surfaces we have read (the tool_invocation event, the published OpenAPI spec)
	 * carries it, so the default is null and the model-supplied agent_line is the source.
	 */
	agentTurnFor: (ctx: ToolInvocationContext) => Promise<string | null>
	scriptVersion: () => string
	/** Runs work after the 200 body is built. Tests swap it to await the work. */
	defer: (work: Promise<unknown>) => void
}

export function defaultToolRouterDeps(): ToolRouterDeps {
	return {
		now: () => new Date(),
		async calendarFor(db, workspaceId) {
			const accessToken = await getCalendarAccessToken(db, workspaceId)
			return accessToken ? createCalendarClient({ accessToken }) : null
		},
		telnyx() {
			const { apiKey, apiBaseUrl } = readTelnyxRuntimeConfig()
			return apiKey ? createTelnyxClient({ apiKey, baseUrl: apiBaseUrl }) : null
		},
		founders: () => parseFounderActors(process.env.VOICE_FOUNDER_ACTORS),
		agentTurnFor: async () => null,
		scriptVersion: () => currentScriptVersion(),
		defer: (work) => {
			work.catch((err) =>
				logger.error('voice tool deferred work failed', {
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		},
	}
}

interface Contact {
	id: string
	title: string
	status: string
	metadata: Record<string, unknown>
	actorId: string
}

async function loadContact(db: Database, ctx: ToolInvocationContext): Promise<Contact | null> {
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
		status: row.status,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		actorId: row.driver ?? row.createdBy,
	}
}

/** The contact is on this call: the reducer stamped last_call_id when the call started. */
function onThisCall(contact: Contact, callId: string): boolean {
	const last = contact.metadata.last_call_id
	return typeof last !== 'string' || last === callId
}

function parseInput<S extends ZodTypeAny>(
	schema: S,
	raw: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; error: ToolError } {
	const parsed = schema.safeParse(raw)
	if (parsed.success) return { ok: true, data: parsed.data }
	return {
		ok: false,
		error: {
			error: 'invalid_input',
			issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`),
		},
	}
}

const ACK = acknowledgedOutput.parse({ acknowledged: true })

type Outcome = { body: unknown }

interface Run {
	db: Database
	ctx: ToolInvocationContext
	contact: Contact
	deps: ToolRouterDeps
}

async function bookMeetingSlot(run: Run, raw: unknown): Promise<Outcome> {
	const input = parseInput(bookMeetingSlotInput, raw)
	if (!input.ok) return { body: input.error }
	const { db, ctx, contact, deps } = run
	const calendarFailed = async (reason: string): Promise<Outcome> => {
		logger.warn('voice calendar failure', { contactId: contact.id, tool: ctx.toolName, reason })
		await patchContactMetadata(db, {
			workspaceId: ctx.clientState.workspace_id,
			contactId: contact.id,
			callId: ctx.callId,
			patch: { followup_action: 'email_calendar_link' },
		})
		return { body: { error: 'calendar_unavailable' } satisfies ToolError }
	}

	let slots: ReturnType<typeof proposeSlots>
	try {
		const calendar = await deps.calendarFor(db, ctx.clientState.workspace_id)
		if (!calendar) return await calendarFailed('no_calendar_connection')
		const now = deps.now()
		const range = slotSearchRange(now)
		const busy = await calendar.freeBusy(range.from, range.to)
		slots = proposeSlots(busy, now, input.data.preferred_window)
	} catch (err) {
		return calendarFailed(err instanceof Error ? err.message : String(err))
	}
	await recordToolSuccess(db, {
		workspaceId: ctx.clientState.workspace_id,
		contactId: contact.id,
		callId: ctx.callId,
		toolName: 'book_meeting_slot',
		// Kept for confirm_meeting_slot, which names an option by index.
		metadata: { voice_offered_slots: { call_id: ctx.callId, slots } },
	})
	return { body: bookMeetingSlotOutput.parse({ slots }) }
}

async function confirmMeetingSlot(run: Run, raw: unknown): Promise<Outcome> {
	const input = parseInput(confirmMeetingSlotInput, raw)
	if (!input.ok) return { body: input.error }
	const { db, ctx, contact, deps } = run
	const workspaceId = ctx.clientState.workspace_id

	// A replay for the same call returns the booking it already made.
	const booked = contact.metadata.voice_meeting as
		| { call_id?: string; event_id?: string; meet_link?: string }
		| undefined
	if (booked?.call_id === ctx.callId && booked.event_id && booked.meet_link) {
		return {
			body: confirmMeetingSlotOutput.parse({
				event_id: booked.event_id,
				meet_link: booked.meet_link,
			}),
		}
	}

	const offered = contact.metadata.voice_offered_slots as
		| { call_id?: string; slots?: Array<{ start_iso: string; end_iso: string }> }
		| undefined
	const slot =
		offered?.call_id === ctx.callId ? offered.slots?.[input.data.slot_index - 1] : undefined
	if (!slot) return { body: { error: 'unknown_slot' } satisfies ToolError }

	let event: Awaited<ReturnType<CalendarClient['insertEvent']>>
	try {
		const calendar = await deps.calendarFor(db, workspaceId)
		if (!calendar) throw new Error('no_calendar_connection')
		event = await calendar.insertEvent({
			eventId: calendarEventId(ctx.callId, slot.start_iso),
			summary: `Maskin intro call with ${input.data.prospect_name}`,
			start: new Date(slot.start_iso),
			end: new Date(slot.end_iso),
			attendeeEmail: input.data.prospect_email,
			attendeeName: input.data.prospect_name,
		})
	} catch (err) {
		logger.warn('voice calendar failure', {
			contactId: contact.id,
			tool: ctx.toolName,
			reason: err instanceof Error ? err.message : String(err),
		})
		// A hint for a human to follow up by hand. Nothing sends from it.
		await patchContactMetadata(db, {
			workspaceId,
			contactId: contact.id,
			callId: ctx.callId,
			patch: { followup_action: 'email_calendar_link' },
		})
		return { body: { error: 'calendar_unavailable' } satisfies ToolError }
	}

	// Success only: this entry is what resolves the call to voice_meeting_booked at hangup. A
	// failure here is ours, not Google's: it propagates, Telnyx retries, and the deterministic
	// event id makes the retry come back as the same booking.
	await recordToolSuccess(db, {
		workspaceId,
		contactId: contact.id,
		callId: ctx.callId,
		toolName: 'confirm_meeting_slot',
		metadata: {
			voice_meeting: { call_id: ctx.callId, event_id: event.eventId, meet_link: event.meetLink },
			// A failure earlier in this call is superseded by the booking that went through.
			followup_action: null,
		},
	})
	return {
		body: confirmMeetingSlotOutput.parse({ event_id: event.eventId, meet_link: event.meetLink }),
	}
}

/** "10:00-15:00" to minutes since midnight, or null when it is not that shape. */
export function parseTransferHours(raw: unknown): { from: number; to: number } | null {
	if (typeof raw !== 'string') return null
	const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim())
	if (!m) return null
	const from = Number(m[1]) * 60 + Number(m[2])
	const to = Number(m[3]) * 60 + Number(m[4])
	return from < to && to <= 24 * 60 ? { from, to } : null
}

async function startTransfer(run: Run, reason: string): Promise<void> {
	const { db, ctx, contact, deps } = run
	const workspaceId = ctx.clientState.workspace_id
	const fallback = (why: string) =>
		pingSales(db, {
			workspaceId,
			contactId: contact.id,
			actorId: contact.actorId,
			attention: 3,
			reason: why,
			data: { call_id: ctx.callId },
		})

	// The target is the contact's owner: metadata.owner is a slug, VOICE_FOUNDER_ACTORS maps it to the actor.
	const founders = deps.founders()
	const owner =
		typeof contact.metadata.owner === 'string' ? contact.metadata.owner.trim().toLowerCase() : ''
	const targetId =
		founders.ok && Object.hasOwn(founders.map, owner) ? founders.map[owner] : undefined
	if (!targetId) return fallback('transfer_skipped_no_target_actor')
	const [target] = await db
		.select({ metadata: actors.metadata })
		.from(actors)
		.where(eq(actors.id, targetId))
		.limit(1)
	const targetMeta = (target?.metadata ?? {}) as Record<string, unknown>
	const number = targetMeta.transfer_phone_e164
	if (typeof number !== 'string' || !E164_RE.test(number)) {
		return fallback('transfer_skipped_no_number')
	}

	const hours =
		parseTransferHours(targetMeta.transfer_hours) ?? parseTransferHours(DEFAULT_TRANSFER_HOURS)
	const local = copenhagenParts(deps.now())
	const minutes = local.hour * 60 + local.minute
	if (!hours || minutes < hours.from || minutes >= hours.to) {
		return fallback('transfer_skipped_outside_hours')
	}

	const telnyx = deps.telnyx()
	if (!telnyx) return fallback('transfer_skipped_telnyx_not_configured')
	try {
		await telnyx.transferCall({
			callControlId: ctx.callId,
			to: number,
			timeoutSecs: TRANSFER_TIMEOUT_SECS,
			// The summary the person who picks up hears about, as SIP headers.
			customHeaders: [
				{ name: 'X-Maskin-Summary', value: reason.replace(/[\r\n]+/g, ' ').slice(0, 200) },
			],
		})
	} catch (err) {
		await fallback(`transfer_request_failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

async function flagInterest(run: Run, raw: unknown): Promise<Outcome> {
	const input = parseInput(flagInterestInput, raw)
	if (!input.ok) return { body: input.error }
	const { db, ctx, contact, deps } = run
	await recordToolSuccess(db, {
		workspaceId: ctx.clientState.workspace_id,
		contactId: contact.id,
		callId: ctx.callId,
		toolName: 'flag_interest',
		metadata: {
			voice_interest: {
				call_id: ctx.callId,
				strength: input.data.strength,
				reason: input.data.reason,
			},
		},
	})
	// Fire and forget: the agent carries on with booking while the transfer rings.
	if (input.data.strength === 'hot') deps.defer(startTransfer(run, input.data.reason))
	return { body: ACK }
}

async function endCallPolite(run: Run, raw: unknown): Promise<Outcome> {
	const input = parseInput(endCallPoliteInput, raw)
	if (!input.ok) return { body: input.error }
	const { db, ctx, contact } = run
	await recordToolSuccess(db, {
		workspaceId: ctx.clientState.workspace_id,
		contactId: contact.id,
		callId: ctx.callId,
		toolName: 'end_call_polite',
		metadata: { voice_end_reason: input.data.reason },
	})
	return { body: ACK }
}

async function requestFollowupEmail(run: Run, raw: unknown): Promise<Outcome> {
	const input = parseInput(requestFollowupEmailInput, raw)
	if (!input.ok) return { body: input.error }
	const { db, ctx, contact, deps } = run

	// The address always comes from the contact, never from the model.
	const email = contact.metadata.email
	if (typeof email !== 'string' || email.trim() === '') {
		return { body: { error: 'no_address_on_file' } satisfies ToolError }
	}

	const telnyxTurn = await deps.agentTurnFor(ctx).catch(() => null)
	const agentTurn = telnyxTurn ?? input.data.agent_line ?? null
	if (agentTurn === null) return { body: { error: 'agent_line_required' } satisfies ToolError }

	await recordToolSuccess(db, {
		workspaceId: ctx.clientState.workspace_id,
		contactId: contact.id,
		callId: ctx.callId,
		toolName: 'request_followup_email',
		audit: {
			action: 'voice_followup_email_requested',
			data: {
				call_id: ctx.callId,
				requested_at: deps.now().toISOString(),
				prospect_quote: input.data.prospect_quote,
				agent_turn: agentTurn,
				script_version: deps.scriptVersion(),
				confirmed_address: email,
				agent_turn_source: telnyxTurn !== null ? 'telnyx' : 'model',
			},
		},
	})
	// Sends nothing: the post-call hook sends, and only when this entry is in the trace.
	return { body: ACK }
}

const HANDLERS: Record<
	(typeof DECLARED_TOOL_NAMES)[number],
	(run: Run, raw: unknown) => Promise<Outcome>
> = {
	book_meeting_slot: bookMeetingSlot,
	confirm_meeting_slot: confirmMeetingSlot,
	flag_interest: flagInterest,
	end_call_polite: endCallPolite,
	request_followup_email: requestFollowupEmail,
}

function isDeclared(name: string): name is (typeof DECLARED_TOOL_NAMES)[number] {
	return (DECLARED_TOOL_NAMES as readonly string[]).includes(name)
}

export function createToolRouter(overrides: Partial<ToolRouterDeps> = {}): ToolHandler {
	const deps: ToolRouterDeps = { ...defaultToolRouterDeps(), ...overrides }
	return async (ctx) => {
		if ((DISABLED_TOOL_NAMES as readonly string[]).includes(ctx.toolName)) {
			// Off for the pilot: sends nothing, appends no trace entry, writes no event.
			return { error: 'not_enabled' } satisfies ToolError
		}
		if (!isDeclared(ctx.toolName)) return { error: 'unknown_tool' } satisfies ToolError

		const contact = await loadContact(ctx.db, ctx)
		if (!contact || !onThisCall(contact, ctx.callId)) {
			return { error: 'call_not_current' } satisfies ToolError
		}
		const { body } = await HANDLERS[ctx.toolName]({ db: ctx.db, ctx, contact, deps }, ctx.toolInput)
		return body
	}
}

/** Wires the router into the webhook route's dispatch seam. Called once at app boot. */
export function registerTelnyxToolRouter(overrides: Partial<ToolRouterDeps> = {}): void {
	registerToolHandler(createToolRouter(overrides))
}
