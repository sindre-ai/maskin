import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarApi } from '../../lib/integrations/providers/google-calendar/client'
import { SCRIPT_VERSION } from '../../lib/integrations/providers/telnyx/assistant'
import type { TelnyxClient } from '../../lib/integrations/providers/telnyx/client'
import type { ToolInvocationContext } from '../../lib/integrations/providers/telnyx/tool-dispatch'
import { createToolRouter } from '../../lib/integrations/providers/telnyx/tools'
import type { SalesNotice, SalesNotifier } from '../../lib/outreach/voice/notify-sales'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Tuesday 2026-10-06, 11:00 Copenhagen (CEST): inside the default 10:00-15:00 transfer window.
const IN_WINDOW = new Date('2026-10-06T09:00:00Z')
// Same day, 17:00 Copenhagen: outside it.
const OUT_OF_WINDOW = new Date('2026-10-06T15:00:00Z')

const PROSPECT = { prospect_email: 'prospect@example.com', prospect_name: 'Pia Prospect' }

interface Harness {
	calendar: { freeBusy: ReturnType<typeof vi.fn>; insertEvent: ReturnType<typeof vi.fn> }
	telnyx: {
		transferCall: ReturnType<typeof vi.fn>
		getConversationMessages: ReturnType<typeof vi.fn>
	}
	notices: SalesNotice[]
	deferred: Promise<unknown>[]
	now: Date
	route: ReturnType<typeof createToolRouter>
}

function harness(now = IN_WINDOW): Harness {
	const h = {
		calendar: {
			freeBusy: vi.fn(async () => []),
			insertEvent: vi.fn(async () => ({
				eventId: 'event-1',
				meetLink: 'https://meet.example/abc',
			})),
		},
		telnyx: {
			transferCall: vi.fn(async () => {}),
			getConversationMessages: vi.fn(async () => []),
		},
		notices: [] as SalesNotice[],
		deferred: [] as Promise<unknown>[],
		now,
	} as Harness
	const notifier: SalesNotifier = {
		notify: async (_db, notice) => {
			h.notices.push(notice)
		},
	}
	h.route = createToolRouter({
		now: () => h.now,
		calendar: async () => h.calendar as unknown as CalendarApi,
		telnyx: () => h.telnyx as unknown as TelnyxClient,
		notifier,
		defer: (work) => {
			h.deferred.push(work)
		},
	})
	return h
}

async function newCall(metadata: Record<string, unknown> = {}, callId = 'call-1') {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		status: 'voice_answered',
		title: 'Pia Prospect',
		metadata: {
			email: 'pia@prospect.example',
			last_call_id: callId,
			voice_tool_trace: [],
			...metadata,
		},
	})
	const invoke = (
		route: ReturnType<typeof createToolRouter>,
		toolName: string,
		toolInput: Record<string, unknown>,
		extra: Partial<ToolInvocationContext> = {},
	) =>
		route({
			db,
			callId,
			toolName,
			toolInput,
			clientState: { contact_id: contact.id, workspace_id: ws.id, dial_attempt_n: 1 },
			from: '+4522222222',
			payload: {},
			...extra,
		})
	const meta = async () => {
		const [row] = await db.select().from(objects).where(eq(objects.id, contact.id))
		return (row?.metadata ?? {}) as Record<string, unknown>
	}
	const trace = async () =>
		((await meta()).voice_tool_trace as Array<{ tool_name: string }>).map((e) => e.tool_name)
	const eventsOf = (action: string) =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, contact.id), eq(events.action, action)))
	return { ws, contact, invoke, meta, trace, eventsOf }
}

describe('tool router: input validation', () => {
	it.each([
		['book_meeting_slot', {}],
		['book_meeting_slot', { prospect_email: '', prospect_name: 'x' }],
		['confirm_meeting_slot', { slot_index: 4, ...PROSPECT }],
		['confirm_meeting_slot', { slot_index: 0, ...PROSPECT }],
		['flag_interest', { strength: 'lukewarm', reason: 'x' }],
		['flag_interest', { strength: 'hot' }],
		['end_call_polite', {}],
		['request_followup_email', {}],
	])('%s rejects %j without writing anything', async (tool, input) => {
		const h = harness()
		const c = await newCall()
		const out = await c.invoke(h.route, tool, input)
		expect(out).toMatchObject({ error: 'invalid_input' })
		expect(await c.trace()).toEqual([])
		expect(h.calendar.freeBusy).not.toHaveBeenCalled()
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
	})

	it('acknowledges a tool name it does not own and does nothing', async () => {
		const c = await newCall()
		expect(await c.invoke(harness().route, 'retrieval', { query: 'x' })).toEqual({
			ok: true,
			handled: false,
		})
		expect(await c.trace()).toEqual([])
	})

	it('answers not_enabled for send_followup_sms: no send, no trace entry, no event', async () => {
		const h = harness()
		const c = await newCall()
		const out = await c.invoke(h.route, 'send_followup_sms', {
			message_body: 'hello',
			mode: 'booking_link',
		})
		expect(out).toMatchObject({ error: 'not_enabled' })
		expect(await c.trace()).toEqual([])
		expect(await c.eventsOf('voice_followup_sms_requested')).toHaveLength(0)
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
	})
})

describe('request_followup_email', () => {
	it('rejects a missing, empty, whitespace-only or over-280-character quote', async () => {
		const h = harness()
		const c = await newCall()
		for (const input of [
			{},
			{ prospect_quote: '' },
			{ prospect_quote: '   ' },
			{ prospect_quote: 'x'.repeat(281) },
		]) {
			expect(await c.invoke(h.route, 'request_followup_email', input)).toMatchObject({
				error: 'invalid_input',
			})
		}
		expect(await c.trace()).toEqual([])
		expect(await c.eventsOf('voice_followup_email_requested')).toHaveLength(0)
	})

	it('trims the quote and accepts exactly 280 characters', async () => {
		const c = await newCall()
		const out = await c.invoke(harness().route, 'request_followup_email', {
			prospect_quote: `  ${'y'.repeat(280)}  `,
		})
		expect(out).toEqual({ acknowledged: true })
		const [event] = await c.eventsOf('voice_followup_email_requested')
		expect((event?.data as { prospect_quote: string }).prospect_quote).toBe('y'.repeat(280))
	})

	it('appends the trace entry and writes the consent record with every field', async () => {
		const h = harness()
		const c = await newCall({ email: 'pia@prospect.example' })
		const out = await c.invoke(h.route, 'request_followup_email', {
			prospect_quote: 'yes, that is fine',
			agent_line: 'Just to confirm, one email from Maskin to pia@prospect.example. Okay?',
		})
		expect(out).toEqual({ acknowledged: true })
		expect(await c.trace()).toEqual(['request_followup_email'])
		const rows = await c.eventsOf('voice_followup_email_requested')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({
			call_id: 'call-1',
			prospect_quote: 'yes, that is fine',
			agent_turn: 'Just to confirm, one email from Maskin to pia@prospect.example. Okay?',
			script_version: SCRIPT_VERSION,
			confirmed_address: 'pia@prospect.example',
			agent_turn_source: 'model',
		})
		const at = (rows[0]?.data as { requested_at: string }).requested_at
		expect(new Date(at).toISOString()).toBe(at)
		expect(at).toBe(IN_WINDOW.toISOString())
	})

	it('takes no recipient: an address in the tool input is ignored and the contact email is recorded', async () => {
		const c = await newCall({ email: 'pia@prospect.example' })
		await c.invoke(harness().route, 'request_followup_email', {
			prospect_quote: 'yes',
			prospect_email: 'attacker@evil.example',
		})
		const [event] = await c.eventsOf('voice_followup_email_requested')
		expect((event?.data as { confirmed_address: string }).confirmed_address).toBe(
			'pia@prospect.example',
		)
		expect(JSON.stringify(event?.data)).not.toContain('attacker')
	})

	it('a repeat for the same call leaves one trace entry and one event', async () => {
		const h = harness()
		const c = await newCall()
		await c.invoke(h.route, 'request_followup_email', { prospect_quote: 'yes' })
		const again = await c.invoke(h.route, 'request_followup_email', { prospect_quote: 'yes' })
		expect(again).toEqual({ acknowledged: true })
		expect(await c.trace()).toEqual(['request_followup_email'])
		expect(await c.eventsOf('voice_followup_email_requested')).toHaveLength(1)
	})

	it('two concurrent invocations for the same call still leave one entry and one event', async () => {
		const h = harness()
		const c = await newCall()
		await Promise.all([
			c.invoke(h.route, 'request_followup_email', { prospect_quote: 'yes' }),
			c.invoke(h.route, 'request_followup_email', { prospect_quote: 'yes' }),
		])
		expect(await c.trace()).toEqual(['request_followup_email'])
		expect(await c.eventsOf('voice_followup_email_requested')).toHaveLength(1)
	})

	it('records nothing for a call that is not the contact current call', async () => {
		const c = await newCall({}, 'call-current')
		await c.invoke(
			harness().route,
			'request_followup_email',
			{ prospect_quote: 'yes' },
			{
				callId: 'call-old',
			},
		)
		expect(await c.trace()).toEqual([])
		expect(await c.eventsOf('voice_followup_email_requested')).toHaveLength(0)
	})

	it('answers no_contact_email and records nothing when the contact has no address', async () => {
		const c = await newCall({ email: undefined })
		const out = await c.invoke(harness().route, 'request_followup_email', { prospect_quote: 'yes' })
		expect(out).toMatchObject({ error: 'no_contact_email' })
		expect(await c.trace()).toEqual([])
		expect(await c.eventsOf('voice_followup_email_requested')).toHaveLength(0)
	})

	it('resolves the contact from client_state and the call id, not from anything in the input', async () => {
		const a = await newCall({ email: 'a@prospect.example' }, 'call-a')
		const b = await newCall({ email: 'b@prospect.example' }, 'call-b')
		await a.invoke(harness().route, 'request_followup_email', { prospect_quote: 'yes' })
		expect(await a.trace()).toEqual(['request_followup_email'])
		expect(await b.trace()).toEqual([])
	})

	describe('agent_turn source', () => {
		it('uses a message list on the Telnyx payload first (source telnyx)', async () => {
			const h = harness()
			const c = await newCall()
			await c.invoke(
				h.route,
				'request_followup_email',
				{ prospect_quote: 'yes', agent_line: 'model said this' },
				{
					payload: {
						messages: [
							{ role: 'assistant', text: 'Hi Pia, this is an AI assistant' },
							{ role: 'user', text: 'send me an email' },
							{ role: 'assistant', text: 'Telnyx remembers this confirmation line' },
							{ role: 'user', text: 'yes' },
						],
					},
				},
			)
			const [event] = await c.eventsOf('voice_followup_email_requested')
			expect(event?.data).toMatchObject({
				agent_turn: 'Telnyx remembers this confirmation line',
				agent_turn_source: 'telnyx',
			})
			expect(h.telnyx.getConversationMessages).not.toHaveBeenCalled()
		})

		it('fetches the conversation by id when the payload has no messages (source telnyx)', async () => {
			const h = harness()
			h.telnyx.getConversationMessages.mockResolvedValue([
				{ role: 'assistant', text: 'opening' },
				{ role: 'user', text: 'email me' },
				{ role: 'assistant', text: 'fetched confirmation line' },
				{ role: 'user', text: 'yes' },
			])
			const c = await newCall()
			await c.invoke(
				h.route,
				'request_followup_email',
				{ prospect_quote: 'yes' },
				{ payload: { conversation_id: 'conv-9' } },
			)
			const [event] = await c.eventsOf('voice_followup_email_requested')
			expect(h.telnyx.getConversationMessages).toHaveBeenCalledWith('conv-9')
			expect(event?.data).toMatchObject({
				agent_turn: 'fetched confirmation line',
				agent_turn_source: 'telnyx',
			})
		})

		it('falls back to the model-supplied line when Telnyx gives neither (source model)', async () => {
			const h = harness()
			h.telnyx.getConversationMessages.mockRejectedValue(new Error('404'))
			const c = await newCall()
			await c.invoke(
				h.route,
				'request_followup_email',
				{ prospect_quote: 'yes', agent_line: 'the line the model reports' },
				{ payload: { conversation_id: 'conv-9' } },
			)
			const [event] = await c.eventsOf('voice_followup_email_requested')
			expect(event?.data).toMatchObject({
				agent_turn: 'the line the model reports',
				agent_turn_source: 'model',
			})
			expect(await c.trace()).toEqual(['request_followup_email'])
		})

		it('still records the request, with no agent turn, when nothing supplies one', async () => {
			const c = await newCall()
			await c.invoke(harness().route, 'request_followup_email', { prospect_quote: 'yes' })
			const [event] = await c.eventsOf('voice_followup_email_requested')
			expect(event?.data).toMatchObject({ agent_turn: null, agent_turn_source: 'model' })
		})
	})
})

describe('book_meeting_slot and confirm_meeting_slot', () => {
	it('offers up to three slots and remembers them for the confirm', async () => {
		const h = harness()
		const c = await newCall()
		const out = (await c.invoke(h.route, 'book_meeting_slot', PROSPECT)) as {
			slots: Array<{ start_iso: string; end_iso: string }>
		}
		expect(out.slots).toHaveLength(3)
		expect(h.calendar.freeBusy).toHaveBeenCalledOnce()
		expect(await c.trace()).toEqual(['book_meeting_slot'])
		const offered = (await c.meta()).voice_offered_slots as { call_id: string; slots: unknown[] }
		expect(offered.call_id).toBe('call-1')
		expect(offered.slots).toEqual(out.slots)
	})

	it('confirms an offered slot with the prospect as an attendee, sendUpdates none is the client default', async () => {
		const h = harness()
		const c = await newCall()
		const { slots } = (await c.invoke(h.route, 'book_meeting_slot', PROSPECT)) as {
			slots: Array<{ start_iso: string; end_iso: string }>
		}
		const out = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 2, ...PROSPECT })
		expect(out).toEqual({ event_id: 'event-1', meet_link: 'https://meet.example/abc' })
		expect(h.calendar.insertEvent).toHaveBeenCalledOnce()
		expect(h.calendar.insertEvent.mock.calls[0]?.[0]).toMatchObject({
			startIso: slots[1]?.start_iso,
			endIso: slots[1]?.end_iso,
			attendee: { email: PROSPECT.prospect_email, displayName: PROSPECT.prospect_name },
		})
		expect(await c.trace()).toEqual(['book_meeting_slot', 'confirm_meeting_slot'])
	})

	it('writes voice_meeting = { call_id, event_id, meet_link } on a successful confirm', async () => {
		const h = harness()
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		expect((await c.meta()).voice_meeting).toEqual({
			call_id: 'call-1',
			event_id: 'event-1',
			meet_link: 'https://meet.example/abc',
		})
	})

	it('keeps other contact metadata when it writes voice_meeting (a merge, not a rewrite)', async () => {
		const h = harness()
		const c = await newCall({ owner: 'sebk', custom: { nested: true } })
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		const m = await c.meta()
		expect(m.owner).toBe('sebk')
		expect(m.custom).toEqual({ nested: true })
		expect(m.email).toBe('pia@prospect.example')
	})

	it('writes meet_link null and still counts the booking when Google returns no link', async () => {
		const h = harness()
		h.calendar.insertEvent.mockResolvedValue({ eventId: 'event-2', meetLink: null })
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		const out = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		expect(out).toEqual({ event_id: 'event-2', meet_link: null })
		expect((await c.meta()).voice_meeting).toEqual({
			call_id: 'call-1',
			event_id: 'event-2',
			meet_link: null,
		})
		expect(await c.trace()).toContain('confirm_meeting_slot')
	})

	it('writes no voice_meeting and no trace entry when the Calendar insert fails, and stamps followup_action', async () => {
		const h = harness()
		h.calendar.insertEvent.mockRejectedValue(new Error('google 503'))
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		const out = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		expect(out).toMatchObject({ error: 'calendar_unavailable' })
		expect((out as { message: string }).message).toContain('did not go through')
		expect((out as { message: string }).message).toContain('Do not promise an email')
		const m = await c.meta()
		expect(m.voice_meeting).toBeUndefined()
		expect(m.followup_action).toBe('email_calendar_link')
		expect(await c.trace()).toEqual(['book_meeting_slot'])
	})

	it('writes no voice_meeting when the confirm is rejected by validation', async () => {
		const h = harness()
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 9, ...PROSPECT })
		expect((await c.meta()).voice_meeting).toBeUndefined()
		expect(h.calendar.insertEvent).not.toHaveBeenCalled()
	})

	it('a replay for the same call returns the same booking and inserts one event', async () => {
		const h = harness()
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		const first = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		const second = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		expect(second).toEqual(first)
		expect(h.calendar.insertEvent).toHaveBeenCalledOnce()
		expect(await c.trace().then((t) => t.filter((n) => n === 'confirm_meeting_slot'))).toHaveLength(
			1,
		)
		expect((await c.meta()).voice_meeting).toEqual({
			call_id: 'call-1',
			event_id: 'event-1',
			meet_link: 'https://meet.example/abc',
		})
	})

	it('a confirm on a later call replaces the earlier call value with its own call id', async () => {
		const h = harness()
		const c = await newCall()
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT)
		await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		// The reducer starts a new call: a new last_call_id and an empty trace.
		await db
			.update(objects)
			.set({ metadata: { ...(await c.meta()), last_call_id: 'call-2', voice_tool_trace: [] } })
			.where(eq(objects.id, c.contact.id))
		h.calendar.insertEvent.mockResolvedValue({
			eventId: 'event-9',
			meetLink: 'https://meet.example/new',
		})
		await c.invoke(h.route, 'book_meeting_slot', PROSPECT, { callId: 'call-2' })
		await c.invoke(
			h.route,
			'confirm_meeting_slot',
			{ slot_index: 1, ...PROSPECT },
			{ callId: 'call-2' },
		)
		expect((await c.meta()).voice_meeting).toEqual({
			call_id: 'call-2',
			event_id: 'event-9',
			meet_link: 'https://meet.example/new',
		})
	})

	it('tells the agent to book first when no slots were offered on this call', async () => {
		const h = harness()
		const c = await newCall()
		const out = await c.invoke(h.route, 'confirm_meeting_slot', { slot_index: 1, ...PROSPECT })
		expect(out).toMatchObject({ error: 'no_slots_offered' })
		expect(h.calendar.insertEvent).not.toHaveBeenCalled()
	})

	it('treats a malformed prospect email as a Calendar failure: no call to Google, followup_action stamped', async () => {
		const h = harness()
		const c = await newCall()
		const out = await c.invoke(h.route, 'book_meeting_slot', {
			prospect_email: 'not-an-email',
			prospect_name: 'Pia',
		})
		expect(out).toMatchObject({ error: 'calendar_unavailable' })
		expect(h.calendar.freeBusy).not.toHaveBeenCalled()
		expect((await c.meta()).followup_action).toBe('email_calendar_link')
		expect(await c.trace()).toEqual([])
	})

	it('treats a missing Google Calendar integration as a Calendar failure', async () => {
		const route = createToolRouter({
			calendar: async () => null,
			notifier: { notify: async () => {} },
		})
		const c = await newCall()
		const out = await c.invoke(route, 'book_meeting_slot', PROSPECT)
		expect(out).toMatchObject({ error: 'calendar_unavailable' })
		expect((await c.meta()).followup_action).toBe('email_calendar_link')
	})
})

describe('flag_interest', () => {
	async function founder(metadata: Record<string, unknown>) {
		return insertActor(db, { type: 'human', metadata })
	}

	it('hot, in the window, with a number: starts a warm transfer with the summary in a SIP header', async () => {
		const target = await founder({ transfer_phone_e164: '+4570123456' })
		const h = harness(IN_WINDOW)
		const c = await newCall({ transfer_target_actor_id: target.id })
		const out = await c.invoke(h.route, 'flag_interest', {
			strength: 'hot',
			reason: 'wants a call now',
		})
		expect(out).toEqual({ acknowledged: true })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).toHaveBeenCalledOnce()
		const [callId, input] = h.telnyx.transferCall.mock.calls[0] as [string, Record<string, unknown>]
		expect(callId).toBe('call-1')
		expect(input).toMatchObject({ to: '+4570123456', timeoutSecs: 15 })
		expect(JSON.stringify(input.customHeaders)).toContain('wants a call now')
		expect(h.notices).toHaveLength(0)
		expect(((await c.meta()).voice_interest as { ping: string }).ping).toBe('not_needed')
	})

	it('hot, outside the transfer_hours window: no transfer, and the lead is pinged at hangup', async () => {
		const target = await founder({
			transfer_phone_e164: '+4570123456',
			transfer_hours: '10:00-15:00',
		})
		const h = harness(OUT_OF_WINDOW)
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
		expect(((await c.meta()).voice_interest as { ping: string }).ping).toBe('pending')
	})

	it('honours a custom transfer_hours window', async () => {
		const target = await founder({
			transfer_phone_e164: '+4570123456',
			transfer_hours: '16:00-18:00',
		})
		const h = harness(OUT_OF_WINDOW)
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).toHaveBeenCalledOnce()
	})

	it('hot with no transfer number: skips the transfer and pings #sales at Attention 3', async () => {
		const target = await founder({})
		const h = harness()
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
		expect(h.notices).toHaveLength(1)
		expect(h.notices[0]).toMatchObject({ attention: 3, contactId: c.contact.id })
		expect(((await c.meta()).voice_interest as { ping: string }).ping).toBe('pending')
	})

	it('hot with a number that is not E.164: skipped like a missing number', async () => {
		const target = await founder({ transfer_phone_e164: '0045 70 12 34 56' })
		const h = harness()
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
		expect(h.notices[0]).toMatchObject({ attention: 3 })
	})

	it('hot when starting the transfer fails: pings #sales at Attention 3 and falls back to the hangup ping', async () => {
		const target = await founder({ transfer_phone_e164: '+4570123456' })
		const h = harness()
		h.telnyx.transferCall.mockRejectedValue(new Error('telnyx 500'))
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.notices).toHaveLength(1)
		expect(h.notices[0]).toMatchObject({ attention: 3, action: 'voice_transfer_failed_ping' })
		expect(((await c.meta()).voice_interest as { ping: string }).ping).toBe('pending')
	})

	it('warm: never transfers, records the interest and leaves the ping for hangup', async () => {
		const target = await founder({ transfer_phone_e164: '+4570123456' })
		const h = harness()
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'warm', reason: 'open to a meeting' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).not.toHaveBeenCalled()
		expect((await c.meta()).voice_interest).toMatchObject({
			call_id: 'call-1',
			strength: 'warm',
			reason: 'open to a meeting',
			ping: 'pending',
		})
		expect(await c.trace()).toEqual(['flag_interest'])
	})

	it('a retried hot flag on the same call does not transfer twice', async () => {
		const target = await founder({ transfer_phone_e164: '+4570123456' })
		const h = harness()
		const c = await newCall({ transfer_target_actor_id: target.id })
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		await c.invoke(h.route, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(h.deferred)
		expect(h.telnyx.transferCall).toHaveBeenCalledOnce()
	})
})

describe('end_call_polite', () => {
	it('sets voice_end_reason and appends to the trace', async () => {
		const c = await newCall()
		const out = await c.invoke(harness().route, 'end_call_polite', { reason: 'not interested' })
		expect(out).toEqual({ acknowledged: true })
		expect((await c.meta()).voice_end_reason).toBe('not interested')
		expect(await c.trace()).toEqual(['end_call_polite'])
	})
})

describe('trace writer', () => {
	beforeEach(() => undefined)

	it('leaves keys another writer set in the same transaction window intact', async () => {
		const h = harness()
		const c = await newCall({ owner: 'magnus' })
		await Promise.all([
			c.invoke(h.route, 'end_call_polite', { reason: 'bye' }),
			db.update(objects).set({ updatedAt: new Date() }).where(eq(objects.id, c.contact.id)),
		])
		expect((await c.meta()).owner).toBe('magnus')
	})
})
