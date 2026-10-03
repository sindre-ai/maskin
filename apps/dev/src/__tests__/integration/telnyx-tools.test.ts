import { events, actors, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarClient } from '../../lib/integrations/providers/google-calendar/calendar-client'
import { encodeClientState } from '../../lib/integrations/providers/telnyx/client'
import { createToolRouter } from '../../lib/integrations/providers/telnyx/tools'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const SCRIPT_VERSION = 'hash-under-test'
const CALL = 'call-1'
const NOW = new Date('2026-10-05T09:30:00Z') // Monday 11:30 in Copenhagen

function calendarStub(overrides: Partial<CalendarClient> = {}) {
	const insertEvent = vi.fn(async (i: { eventId: string }) => ({
		eventId: i.eventId,
		meetLink: 'https://meet.google.com/abc-defg-hij',
	}))
	const client: CalendarClient = {
		freeBusy: async () => [],
		insertEvent,
		...overrides,
	}
	return { client, insertEvent }
}

async function setup(metadata: Record<string, unknown> = {}) {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		status: 'voice_answered',
		metadata: { last_call_id: CALL, voice_tool_trace: [], email: 'anna@example.dk', ...metadata },
	})
	const clientState = { contact_id: contact.id, workspace_id: ws.id, dial_attempt_n: 1 }
	void encodeClientState
	const read = async () => {
		const [row] = await db.select().from(objects).where(eq(objects.id, contact.id))
		return (row?.metadata ?? {}) as Record<string, unknown>
	}
	const audit = (action: string) =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, contact.id), eq(events.action, action)))
	const call = (
		router: ReturnType<typeof createToolRouter>,
		toolName: string,
		toolInput: Record<string, unknown>,
		callId = CALL,
	) => router({ db, callId, toolName, toolInput, clientState })
	return { ws, contact, read, audit, call }
}

function router(overrides: Parameters<typeof createToolRouter>[0] = {}) {
	return createToolRouter({
		now: () => NOW,
		scriptVersion: () => SCRIPT_VERSION,
		agentTurnFor: async () => null,
		...overrides,
	})
}

const traceNames = (m: Record<string, unknown>) =>
	((m.voice_tool_trace as Array<{ tool_name: string }>) ?? []).map((e) => e.tool_name)

describe('Telnyx tool router: routing', () => {
	it('answers not_enabled for send_followup_sms and does nothing else', async () => {
		const t = await setup()
		const out = await t.call(router(), 'send_followup_sms', {
			mode: 'booking_link',
			message_body: 'hi',
		})
		expect(out).toEqual({ error: 'not_enabled' })
		expect(traceNames(await t.read())).toEqual([])
		expect(await t.audit('voice_sales_ping')).toHaveLength(0)
	})

	it('answers unknown_tool for a name that is not declared', async () => {
		const t = await setup()
		expect(await t.call(router(), 'lookup_contact_context', {})).toEqual({ error: 'unknown_tool' })
	})

	it('does nothing for a call that is not the contact current call', async () => {
		const t = await setup()
		const out = await t.call(router(), 'end_call_polite', { reason: 'bye' }, 'older-call')
		expect(out).toEqual({ error: 'call_not_current' })
		expect(traceNames(await t.read())).toEqual([])
	})

	it('rejects invalid input with a Zod message and leaves no trace', async () => {
		const t = await setup()
		const r = router()
		for (const [tool, input] of [
			['book_meeting_slot', { prospect_email: 'not-an-email', prospect_name: 'Anna' }],
			['confirm_meeting_slot', { slot_index: 5, prospect_email: 'a@b.dk', prospect_name: 'A' }],
			['flag_interest', { strength: 'lukewarm', reason: 'x' }],
			['end_call_polite', {}],
			['request_followup_email', {}],
		] as const) {
			const out = (await t.call(r, tool, input)) as { error: string; issues: string[] }
			expect(out.error, tool).toBe('invalid_input')
			expect(out.issues.length, tool).toBeGreaterThan(0)
		}
		expect(traceNames(await t.read())).toEqual([])
	})
})

describe('Telnyx tool router: end_call_polite and flag_interest', () => {
	it('end_call_polite sets voice_end_reason and records the trace entry once', async () => {
		const t = await setup()
		const r = router()
		expect(await t.call(r, 'end_call_polite', { reason: 'not now' })).toEqual({
			acknowledged: true,
		})
		await t.call(r, 'end_call_polite', { reason: 'not now' })
		const m = await t.read()
		expect(m.voice_end_reason).toBe('not now')
		expect(traceNames(m)).toEqual(['end_call_polite'])
	})

	it('flag_interest warm records the interest and does not try to transfer', async () => {
		const t = await setup()
		const transferCall = vi.fn()
		const work: Promise<unknown>[] = []
		const r = router({
			telnyx: () => ({ transferCall }) as never,
			defer: (p) => work.push(p),
		})
		expect(await t.call(r, 'flag_interest', { strength: 'warm', reason: 'send more' })).toEqual({
			acknowledged: true,
		})
		await Promise.all(work)
		expect(transferCall).not.toHaveBeenCalled()
		const m = await t.read()
		expect(m.voice_interest).toMatchObject({ call_id: CALL, strength: 'warm' })
		expect(traceNames(m)).toEqual(['flag_interest'])
	})

	async function hot(actorMeta: Record<string, unknown> | null, now = NOW) {
		const target = actorMeta
			? await insertActor(db, { type: 'human', name: 'Sebk', metadata: actorMeta })
			: null
		const t = await setup(target ? { owner: 'sebk' } : {})
		const transferCall = vi.fn(async () => {})
		const work: Promise<unknown>[] = []
		const r = router({
			now: () => now,
			founders: () => ({ ok: true, map: target ? { sebk: target.id } : {} }),
			telnyx: () => ({ transferCall }) as never,
			defer: (p) => work.push(p),
		})
		const out = await t.call(r, 'flag_interest', { strength: 'hot', reason: 'wants to talk now' })
		await Promise.all(work)
		return { t, out, transferCall }
	}

	it('flag_interest hot transfers to the number on the target actor within the window', async () => {
		const { out, transferCall } = await hot({ transfer_phone_e164: '+4512345678' })
		expect(out).toEqual({ acknowledged: true })
		expect(transferCall).toHaveBeenCalledWith(
			expect.objectContaining({ callControlId: CALL, to: '+4512345678', timeoutSecs: 15 }),
		)
	})

	it('the transfer command carries a client_state that names the contact and Leg A', async () => {
		const { t, transferCall } = await hot({ transfer_phone_e164: '+4512345678' })
		const [input] = transferCall.mock.calls[0] as unknown as [{ clientState: unknown }]
		expect(input.clientState).toEqual({
			contact_id: t.contact.id,
			workspace_id: t.ws.id,
			dial_attempt_n: 1,
			transfer_of: CALL,
		})
	})

	it('hot with no number on the target actor skips the transfer and pings #sales at Attention 3', async () => {
		const { t, transferCall } = await hot({})
		expect(transferCall).not.toHaveBeenCalled()
		const [ping] = await t.audit('voice_sales_ping')
		expect(ping?.data).toMatchObject({
			attention: 3,
			channel: '#sales',
			reason: 'transfer_skipped_no_number',
		})
	})

	it('hot with an owner that is not in VOICE_FOUNDER_ACTORS skips the transfer and pings #sales', async () => {
		const { t, transferCall } = await hot(null)
		expect(transferCall).not.toHaveBeenCalled()
		const [ping] = await t.audit('voice_sales_ping')
		expect(ping?.data).toMatchObject({ attention: 3, reason: 'transfer_skipped_no_target_actor' })
	})

	it('hot with a malformed number does not transfer', async () => {
		const { t, transferCall } = await hot({ transfer_phone_e164: '12345678' })
		expect(transferCall).not.toHaveBeenCalled()
		expect(await t.audit('voice_sales_ping')).toHaveLength(1)
	})

	it('hot outside transfer_hours (default 10:00-15:00 Copenhagen) skips the transfer', async () => {
		const { t, transferCall } = await hot(
			{ transfer_phone_e164: '+4512345678' },
			new Date('2026-10-05T14:30:00Z'), // 16:30 Copenhagen
		)
		expect(transferCall).not.toHaveBeenCalled()
		const [ping] = await t.audit('voice_sales_ping')
		expect(ping?.data).toMatchObject({ reason: 'transfer_skipped_outside_hours' })
	})

	it('hot honours a custom transfer_hours on the target actor', async () => {
		const { transferCall } = await hot(
			{ transfer_phone_e164: '+4512345678', transfer_hours: '16:00-18:00' },
			new Date('2026-10-05T14:30:00Z'),
		)
		expect(transferCall).toHaveBeenCalledTimes(1)
	})

	it('a failed transfer request pings #sales at Attention 3', async () => {
		const target = await insertActor(db, {
			type: 'human',
			name: 'Sebk',
			metadata: { transfer_phone_e164: '+4512345678' },
		})
		const t = await setup({ owner: 'sebk' })
		const work: Promise<unknown>[] = []
		const r = router({
			founders: () => ({ ok: true, map: { sebk: target.id } }),
			telnyx: () =>
				({
					transferCall: async () => {
						throw new Error('telnyx down')
					},
				}) as never,
			defer: (p) => work.push(p),
		})
		await t.call(r, 'flag_interest', { strength: 'hot', reason: 'now' })
		await Promise.all(work)
		const [ping] = await t.audit('voice_sales_ping')
		expect(String((ping?.data as { reason: string }).reason)).toContain('transfer_request_failed')
	})

	void actors
})

describe('Telnyx tool router: booking', () => {
	const who = { prospect_email: 'anna@example.dk', prospect_name: 'Anna Hansen' }

	it('book_meeting_slot offers 3 slots, stores them for the call, and records the trace', async () => {
		const t = await setup()
		const { client } = calendarStub()
		const out = (await t.call(
			router({ calendarFor: async () => client }),
			'book_meeting_slot',
			who,
		)) as {
			slots: Array<{ start_iso: string }>
		}
		expect(out.slots).toHaveLength(3)
		const m = await t.read()
		expect(m.voice_offered_slots).toMatchObject({ call_id: CALL })
		expect(traceNames(m)).toEqual(['book_meeting_slot'])
	})

	it('confirm_meeting_slot books, writes voice_meeting, and records the trace on success only', async () => {
		const t = await setup({ followup_action: 'email_calendar_link' })
		const { client, insertEvent } = calendarStub()
		const r = router({ calendarFor: async () => client })
		await t.call(r, 'book_meeting_slot', who)
		const out = (await t.call(r, 'confirm_meeting_slot', { slot_index: 2, ...who })) as {
			event_id: string
			meet_link: string
		}
		expect(out.meet_link).toBe('https://meet.google.com/abc-defg-hij')
		expect(insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({ attendeeEmail: 'anna@example.dk' }),
		)
		const m = await t.read()
		expect(m.voice_meeting).toEqual({
			call_id: CALL,
			event_id: out.event_id,
			meet_link: out.meet_link,
		})
		expect(m.followup_action).toBeUndefined()
		expect(traceNames(m)).toEqual(['book_meeting_slot', 'confirm_meeting_slot'])
	})

	it('a replayed confirm_meeting_slot returns the same booking and inserts no second event', async () => {
		const t = await setup()
		const { client, insertEvent } = calendarStub()
		const r = router({ calendarFor: async () => client })
		await t.call(r, 'book_meeting_slot', who)
		const first = await t.call(r, 'confirm_meeting_slot', { slot_index: 1, ...who })
		const second = await t.call(r, 'confirm_meeting_slot', { slot_index: 1, ...who })
		expect(second).toEqual(first)
		expect(insertEvent).toHaveBeenCalledTimes(1)
		expect(traceNames(await t.read()).filter((n) => n === 'confirm_meeting_slot')).toHaveLength(1)
	})

	it('confirm_meeting_slot without offered slots answers unknown_slot and books nothing', async () => {
		const t = await setup()
		const { client, insertEvent } = calendarStub()
		const out = await t.call(router({ calendarFor: async () => client }), 'confirm_meeting_slot', {
			slot_index: 1,
			...who,
		})
		expect(out).toEqual({ error: 'unknown_slot' })
		expect(insertEvent).not.toHaveBeenCalled()
	})

	it('slots offered on an earlier call are not bookable on this one', async () => {
		const t = await setup({
			voice_offered_slots: {
				call_id: 'older-call',
				slots: [{ start_iso: '2026-10-06T08:00:00Z', end_iso: '2026-10-06T08:30:00Z' }],
			},
		})
		const { client } = calendarStub()
		const out = await t.call(router({ calendarFor: async () => client }), 'confirm_meeting_slot', {
			slot_index: 1,
			...who,
		})
		expect(out).toEqual({ error: 'unknown_slot' })
	})

	it('a Calendar failure on confirm stamps followup_action and leaves no confirm entry', async () => {
		const t = await setup()
		const ok = calendarStub()
		const failing = calendarStub({
			insertEvent: async () => {
				throw new Error('google 503')
			},
		})
		let useFailing = false
		const r = router({ calendarFor: async () => (useFailing ? failing.client : ok.client) })
		await t.call(r, 'book_meeting_slot', who)
		useFailing = true
		const out = await t.call(r, 'confirm_meeting_slot', { slot_index: 1, ...who })
		expect(out).toEqual({ error: 'calendar_unavailable' })
		const m = await t.read()
		expect(m.followup_action).toBe('email_calendar_link')
		expect(m.voice_meeting).toBeUndefined()
		expect(traceNames(m)).toEqual(['book_meeting_slot'])
	})

	it('a Calendar failure on book_meeting_slot stamps followup_action', async () => {
		const t = await setup()
		const { client } = calendarStub({
			freeBusy: async () => {
				throw new Error('google down')
			},
		})
		const out = await t.call(router({ calendarFor: async () => client }), 'book_meeting_slot', who)
		expect(out).toEqual({ error: 'calendar_unavailable' })
		const m = await t.read()
		expect(m.followup_action).toBe('email_calendar_link')
		expect(traceNames(m)).toEqual([])
	})

	it('no Calendar connection counts as a Calendar failure', async () => {
		const t = await setup()
		const out = await t.call(router({ calendarFor: async () => null }), 'book_meeting_slot', who)
		expect(out).toEqual({ error: 'calendar_unavailable' })
		expect((await t.read()).followup_action).toBe('email_calendar_link')
	})
})

describe('Telnyx tool router: request_followup_email', () => {
	const input = {
		prospect_quote: 'Yes, please email me',
		agent_line: 'One email from Maskin, opt out any time?',
	}

	it('rejects a missing, empty or over-280-char quote', async () => {
		const t = await setup()
		const r = router()
		for (const bad of [
			{},
			{ prospect_quote: '' },
			{ prospect_quote: '   ' },
			{ prospect_quote: 'x'.repeat(281) },
		]) {
			const out = (await t.call(r, 'request_followup_email', bad)) as { error: string }
			expect(out.error).toBe('invalid_input')
		}
		expect(traceNames(await t.read())).toEqual([])
		expect(await t.audit('voice_followup_email_requested')).toHaveLength(0)
	})

	it('happy path: one trace entry and one event with the full consent record, nothing sent', async () => {
		const t = await setup()
		const out = await t.call(router(), 'request_followup_email', input)
		expect(out).toEqual({ acknowledged: true })
		expect(traceNames(await t.read())).toEqual(['request_followup_email'])
		const rows = await t.audit('voice_followup_email_requested')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toEqual({
			call_id: CALL,
			requested_at: NOW.toISOString(),
			prospect_quote: 'Yes, please email me',
			agent_turn: 'One email from Maskin, opt out any time?',
			script_version: SCRIPT_VERSION,
			confirmed_address: 'anna@example.dk',
			agent_turn_source: 'model',
		})
	})

	it('takes agent_turn from Telnyx when it has a record, and says so', async () => {
		const t = await setup()
		await t.call(
			router({ agentTurnFor: async () => 'Telnyx recorded this turn' }),
			'request_followup_email',
			{ prospect_quote: 'yes' },
		)
		const [row] = await t.audit('voice_followup_email_requested')
		expect(row?.data).toMatchObject({
			agent_turn: 'Telnyx recorded this turn',
			agent_turn_source: 'telnyx',
		})
	})

	it('with no Telnyx source and no agent_line, records nothing and asks for the line', async () => {
		const t = await setup()
		const out = await t.call(router(), 'request_followup_email', { prospect_quote: 'yes' })
		expect(out).toEqual({ error: 'agent_line_required' })
		expect(traceNames(await t.read())).toEqual([])
		expect(await t.audit('voice_followup_email_requested')).toHaveLength(0)
	})

	it('a second invocation for the same call leaves one entry and one event', async () => {
		const t = await setup()
		const r = router()
		await t.call(r, 'request_followup_email', input)
		const again = await t.call(r, 'request_followup_email', input)
		expect(again).toEqual({ acknowledged: true })
		expect(traceNames(await t.read())).toEqual(['request_followup_email'])
		expect(await t.audit('voice_followup_email_requested')).toHaveLength(1)
	})

	it('takes the address from the contact: no email on file means no record', async () => {
		const t = await setup({ email: undefined })
		const out = await t.call(router(), 'request_followup_email', input)
		expect(out).toEqual({ error: 'no_address_on_file' })
		expect(traceNames(await t.read())).toEqual([])
	})

	it('ignores a recipient the model tries to supply', async () => {
		const t = await setup()
		await t.call(router(), 'request_followup_email', { ...input, to: 'evil@example.com' })
		const [row] = await t.audit('voice_followup_email_requested')
		expect(row?.data).toMatchObject({ confirmed_address: 'anna@example.dk' })
		expect(JSON.stringify(row?.data)).not.toContain('evil@example.com')
	})
})
