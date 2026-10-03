import { generateKeyPairSync, sign } from 'node:crypto'
import { events, objects, telnyxWebhookEvents } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as recordEventModule from '../../lib/events/record-event'
import { encodeClientState } from '../../lib/integrations/providers/telnyx/client'
import * as applyModule from '../../lib/outreach/voice/apply'
import type { EffectRunner } from '../../lib/outreach/voice/effects'
import { postCallHooks } from '../../lib/outreach/voice/post-call'
import telnyxWebhookRoutes, {
	setEffectRunnerForTests,
} from '../../routes/integrations-telnyx-webhook'
import { insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY_B64 = publicKey
	.export({ format: 'der', type: 'spki' })
	.subarray(-32)
	.toString('base64')
const PATH = '/api/integrations/telnyx/webhook'

let savedKey: string | undefined
beforeAll(() => {
	savedKey = process.env.TELNYX_PUBLIC_KEY
	process.env.TELNYX_PUBLIC_KEY = PUBLIC_KEY_B64
})
afterAll(() => {
	if (savedKey === undefined) Reflect.deleteProperty(process.env, 'TELNYX_PUBLIC_KEY')
	else process.env.TELNYX_PUBLIC_KEY = savedKey
})

function app() {
	return createIntegrationApp({ path: PATH, module: telnyxWebhookRoutes })
}

let n = 0
function envelope(eventType: string, payload: Record<string, unknown>, eventId?: string) {
	n++
	return JSON.stringify({
		data: {
			id: eventId ?? `evt-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 8)}`,
			event_type: eventType,
			occurred_at: new Date().toISOString(),
			payload,
		},
	})
}

function post(
	body: string,
	opts: { ts?: number; signWith?: typeof privateKey; skipSig?: boolean; tamper?: boolean } = {},
) {
	const ts = opts.ts ?? Math.floor(Date.now() / 1000)
	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (!opts.skipSig) {
		headers['telnyx-timestamp'] = String(ts)
		headers['telnyx-signature-ed25519'] = sign(
			null,
			Buffer.from(`${ts}|${body}`),
			opts.signWith ?? privateKey,
		).toString('base64')
	}
	return app().request(PATH, { method: 'POST', headers, body: opts.tamper ? `${body} ` : body })
}

describe('Telnyx webhook: signature, replay, dedupe, unknown events', () => {
	it('401 when the signature headers are missing', async () => {
		const res = await post(envelope('call.answered', { call_control_id: 'x' }), { skipSig: true })
		expect(res.status).toBe(401)
	})

	it('401 when the signature is from the wrong key', async () => {
		const other = generateKeyPairSync('ed25519')
		const res = await post(envelope('call.answered', { call_control_id: 'x' }), {
			signWith: other.privateKey,
		})
		expect(res.status).toBe(401)
	})

	it('401 when the body was altered after signing', async () => {
		const res = await post(envelope('call.answered', { call_control_id: 'x' }), { tamper: true })
		expect(res.status).toBe(401)
	})

	it('401 for a validly signed replay outside the 300s window', async () => {
		const res = await post(envelope('call.answered', { call_control_id: 'x' }), {
			ts: Math.floor(Date.now() / 1000) - 301,
		})
		expect(res.status).toBe(401)
	})

	it('401 and no state change when TELNYX_PUBLIC_KEY is not configured', async () => {
		const prior = process.env.TELNYX_PUBLIC_KEY
		process.env.TELNYX_PUBLIC_KEY = ''
		try {
			const res = await post(envelope('call.answered', { call_control_id: 'x' }))
			expect(res.status).toBe(401)
		} finally {
			process.env.TELNYX_PUBLIC_KEY = prior
		}
	})

	it('200 and logs for an event type it does not consume, without claiming the id', async () => {
		const eventId = `evt-unknown-${Date.now()}`
		const res = await post(envelope('call.speak.ended', { call_control_id: 'x' }, eventId))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			ok: true,
			skipped: true,
			reason: 'unhandled_event_type',
		})
		const claimed = await db
			.select()
			.from(telnyxWebhookEvents)
			.where(eq(telnyxWebhookEvents.eventId, eventId))
		expect(claimed).toHaveLength(0)
	})

	it('400 for a known type with a malformed payload', async () => {
		const res = await post(
			envelope('call.machine.premium.detection.ended', { call_control_id: 'x' }),
		)
		expect(res.status).toBe(400)
	})

	it('accepts a valid signature and dedupes on event_id: the duplicate has no side effects', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const contact = await insertObject(db, ws.id, getTestActorId(), {
			type: 'contact',
			status: 'voice_queued',
			metadata: {},
		})
		const state = encodeClientState({
			contact_id: contact.id,
			workspace_id: ws.id,
			dial_attempt_n: 1,
		})
		const body = envelope(
			'call.initiated',
			{ call_control_id: 'call-dedupe', client_state: state },
			`evt-dedupe-${Date.now()}`,
		)

		const first = await post(body)
		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({ ok: true, status: 'voice_dialing', applied: true })

		const eventsBefore = await db.select().from(events).where(eq(events.entityId, contact.id))
		const second = await post(body)
		expect(second.status).toBe(200)
		expect(await second.json()).toMatchObject({ ok: true, duplicate: true })
		const eventsAfter = await db.select().from(events).where(eq(events.entityId, contact.id))
		expect(eventsAfter).toHaveLength(eventsBefore.length)
	})

	it('releases the claim and answers 500 when the handler fails, so Telnyx retries', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const contact = await insertObject(db, ws.id, getTestActorId(), {
			type: 'contact',
			status: 'voice_queued',
			metadata: {},
		})
		const state = encodeClientState({
			contact_id: contact.id,
			workspace_id: ws.id,
			dial_attempt_n: 1,
		})
		const eventId = `evt-fail-${Date.now()}`
		const body = envelope(
			'call.initiated',
			{ call_control_id: 'call-fail', client_state: state },
			eventId,
		)
		const spy = vi.spyOn(applyModule, 'applyVoiceEvent').mockRejectedValueOnce(new Error('db down'))
		try {
			const res = await post(body)
			expect(res.status).toBe(500)
			expect(
				await db.select().from(telnyxWebhookEvents).where(eq(telnyxWebhookEvents.eventId, eventId)),
			).toHaveLength(0)
		} finally {
			spy.mockRestore()
		}
		// The retry (same event_id) is processed normally.
		const retry = await post(body)
		expect(retry.status).toBe(200)
		expect(await retry.json()).toMatchObject({ applied: true, status: 'voice_dialing' })
	})
})

describe('Telnyx webhook: reducer drives the contact', () => {
	const sms: Array<{ mode: string; to?: string }> = []
	const hangups: string[] = []
	const runner: EffectRunner = {
		sendSms: async (mode, _ctx, to) => {
			sms.push({ mode, to })
		},
		hangupCall: async (callId) => {
			hangups.push(callId)
		},
		deadLetter: async () => {},
	}

	beforeEach(() => {
		sms.length = 0
		hangups.length = 0
		setEffectRunnerForTests(runner)
		postCallHooks.length = 0
	})
	afterAll(() => setEffectRunnerForTests(null))

	async function newContact(status = 'voice_queued', metadata: Record<string, unknown> = {}) {
		const ws = await insertWorkspace(db, getTestActorId())
		const contact = await insertObject(db, ws.id, getTestActorId(), {
			type: 'contact',
			status,
			metadata,
		})
		const state = (attempt: number) =>
			encodeClientState({ contact_id: contact.id, workspace_id: ws.id, dial_attempt_n: attempt })
		const read = async () => {
			const [row] = await db
				.select()
				.from(objects)
				.where(and(eq(objects.id, contact.id)))
			return { status: row?.status, meta: (row?.metadata ?? {}) as Record<string, unknown> }
		}
		const send = (
			type: string,
			callId: string,
			attempt: number,
			extra: Record<string, unknown> = {},
		) =>
			post(
				envelope(type, {
					call_control_id: callId,
					client_state: state(attempt),
					to: '+4511111111',
					from: '+4522222222',
					...extra,
				}),
			)
		return { ws, contact, read, send }
	}

	it('no_answer: voice_no_answer, SMS fired, next_dial_at set, then retry-cap to voice_failed', async () => {
		const c = await newContact()
		for (const attempt of [1, 2]) {
			expect((await c.send('call.initiated', `call-na-${attempt}`, attempt)).status).toBe(200)
			expect((await c.read()).status).toBe('voice_dialing')
			expect(
				(await c.send('call.hangup', `call-na-${attempt}`, attempt, { hangup_cause: 'no_answer' }))
					.status,
			).toBe(200)
			const after = await c.read()
			expect(after.status).toBe('voice_no_answer')
			expect(typeof after.meta.next_dial_at).toBe('string')
			expect(new Date(after.meta.next_dial_at as string).getTime()).toBeGreaterThan(Date.now())
		}
		expect(sms.map((s) => s.mode)).toEqual(['missed_call_nudge', 'missed_call_nudge'])

		await c.send('call.initiated', 'call-na-3', 3)
		await c.send('call.hangup', 'call-na-3', 3, { hangup_cause: 'no_answer' })
		const final = await c.read()
		expect(final.status).toBe('voice_failed')
		expect(final.meta.next_dial_at).toBeUndefined()
		expect(final.meta.dial_attempt_n).toBe(3)
	})

	it('voicemail via AMD: forced hangup, voicemail SMS, and the trailing hangup does not double up', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-vm', 1)
		await c.send('call.answered', 'call-vm', 1)
		expect((await c.read()).status).toBe('voice_answered')
		await c.send('call.machine.premium.detection.ended', 'call-vm', 1, { result: 'machine' })
		const vm = await c.read()
		expect(vm.status).toBe('voice_voicemail')
		expect(vm.meta.amd_result).toBe('machine')
		expect(hangups).toEqual(['call-vm'])
		expect(sms.map((s) => s.mode)).toEqual(['voicemail_followup'])

		await c.send('call.hangup', 'call-vm', 1, { hangup_cause: 'normal_clearing' })
		expect((await c.read()).status).toBe('voice_voicemail')
		expect(sms).toHaveLength(1)
	})

	it('AMD human only stamps amd_result', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-h', 1)
		await c.send('call.answered', 'call-h', 1)
		await c.send('call.machine.premium.detection.ended', 'call-h', 1, { result: 'human' })
		const after = await c.read()
		expect(after.status).toBe('voice_answered')
		expect(after.meta.amd_result).toBe('human')
		expect(sms).toHaveLength(0)
		expect(hangups).toHaveLength(0)
	})

	it('connected call with no booking resolves to voice_declined and opens the post-call seam once', async () => {
		const hook = vi.fn()
		postCallHooks.push({ name: 'test', run: hook })
		const c = await newContact()
		await c.send('call.initiated', 'call-d', 1)
		await c.send('call.answered', 'call-d', 1)
		await c.send('assistant.tool_invocation', 'call-d', 1, {
			tool_name: 'end_call_polite',
			tool_input: { reason: 'not interested' },
		})
		await c.send('call.hangup', 'call-d', 1, { hangup_cause: 'normal_clearing', duration_s: 41 })
		expect((await c.read()).status).toBe('voice_declined')
		expect(hook).toHaveBeenCalledTimes(1)
		expect(hook.mock.calls[0]?.[0]).toMatchObject({
			contactId: c.contact.id,
			callId: 'call-d',
			status: 'voice_declined',
			durationS: 41,
		})
	})

	it('a confirm_meeting_slot in the trace resolves to voice_meeting_booked', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-b', 1)
		await c.send('call.answered', 'call-b', 1)
		await c.send('assistant.tool_invocation', 'call-b', 1, {
			tool_name: 'confirm_meeting_slot',
			tool_input: {},
		})
		await c.send('call.hangup', 'call-b', 1, { hangup_cause: 'normal_clearing' })
		expect((await c.read()).status).toBe('voice_meeting_booked')
	})

	it('transfer completed resolves to voice_warm_transferred and survives the hangup', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-t', 1)
		await c.send('call.answered', 'call-t', 1)
		await c.send('call.transfer.completed', 'call-t', 1, { target: '+4533333333' })
		await c.send('call.hangup', 'call-t', 1, { hangup_cause: 'normal_clearing' })
		expect((await c.read()).status).toBe('voice_warm_transferred')
	})

	it('a hangup after a warm transfer still opens the post-call seam, without touching the status', async () => {
		const hook = vi.fn()
		postCallHooks.push({ name: 'test', run: hook })
		const c = await newContact()
		await c.send('call.initiated', 'call-wt', 1)
		await c.send('call.answered', 'call-wt', 1)
		await c.send('call.transfer.completed', 'call-wt', 1, { target: '+4533333333' })
		await c.send('call.hangup', 'call-wt', 1, { hangup_cause: 'normal_clearing', duration_s: 90 })
		expect((await c.read()).status).toBe('voice_warm_transferred')
		expect(hook).toHaveBeenCalledTimes(1)
		expect(hook.mock.calls[0]?.[0]).toMatchObject({
			callId: 'call-wt',
			status: 'voice_warm_transferred',
		})
	})

	it('a hangup for an older call does not open the post-call seam', async () => {
		const hook = vi.fn()
		postCallHooks.push({ name: 'test', run: hook })
		const c = await newContact()
		await c.send('call.initiated', 'call-new', 1)
		await c.send('call.hangup', 'call-old', 1, { hangup_cause: 'no_answer' })
		expect(hook).not.toHaveBeenCalled()
		expect((await c.read()).status).toBe('voice_dialing')
	})

	it('a late call.initiated does not revive a declined contact', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-1', 1)
		await c.send('call.answered', 'call-1', 1)
		await c.send('call.hangup', 'call-1', 1, { hangup_cause: 'normal_clearing' })
		expect((await c.read()).status).toBe('voice_declined')
		await c.send('call.initiated', 'call-2', 2)
		expect((await c.read()).status).toBe('voice_declined')
	})

	it('premium human_residence stamps amd_result human', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-hr', 1)
		await c.send('call.answered', 'call-hr', 1)
		await c.send('call.machine.premium.detection.ended', 'call-hr', 1, {
			result: 'human_residence',
		})
		const after = await c.read()
		expect(after.status).toBe('voice_answered')
		expect(after.meta.amd_result).toBe('human')
	})

	it('rolls the state write back with the claim when the transaction fails mid-way', async () => {
		const c = await newContact()
		const eventId = `evt-atomic-${Date.now()}`
		const body = envelope(
			'call.initiated',
			{
				call_control_id: 'call-atomic',
				client_state: encodeClientState({
					contact_id: c.contact.id,
					workspace_id: c.ws.id,
					dial_attempt_n: 1,
				}),
			},
			eventId,
		)
		// Fail AFTER the reducer wrote: the audit event insert is the last write in the transaction.
		const spy = vi
			.spyOn(recordEventModule, 'recordEvent')
			.mockRejectedValueOnce(new Error('events down'))
		try {
			expect((await post(body)).status).toBe(500)
		} finally {
			spy.mockRestore()
		}
		expect((await c.read()).status).toBe('voice_queued')
		expect(
			await db.select().from(telnyxWebhookEvents).where(eq(telnyxWebhookEvents.eventId, eventId)),
		).toHaveLength(0)
		expect((await post(body)).status).toBe(200)
		expect((await c.read()).status).toBe('voice_dialing')
	})

	it('writes an audit event for each status change', async () => {
		const c = await newContact()
		await c.send('call.initiated', 'call-ev', 1)
		const rows = await db.select().from(events).where(eq(events.entityId, c.contact.id))
		expect(rows.some((r) => r.action === 'status_changed')).toBe(true)
	})

	it('200 and no state change for an event whose contact does not exist', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const state = encodeClientState({
			contact_id: crypto.randomUUID(),
			workspace_id: ws.id,
			dial_attempt_n: 1,
		})
		const res = await post(
			envelope('call.answered', { call_control_id: 'call-x', client_state: state }),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ skipped: 'contact_not_found' })
	})

	it('does not touch a contact in another workspace', async () => {
		const c = await newContact()
		const other = await insertWorkspace(db, getTestActorId())
		const state = encodeClientState({
			contact_id: c.contact.id,
			workspace_id: other.id,
			dial_attempt_n: 1,
		})
		const res = await post(
			envelope('call.initiated', { call_control_id: 'call-xws', client_state: state }),
		)
		expect(await res.json()).toMatchObject({ skipped: 'contact_not_found' })
		expect((await c.read()).status).toBe('voice_queued')
	})
})
