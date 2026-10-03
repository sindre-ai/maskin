import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { clientState, postTelnyxWebhook, telnyxEvent } from '../helpers/telnyx.helper'

// Voice outreach state reducer, driven end to end by signed webhook events
// (bet 5b8e). Each test is one contact walked through its calls.

async function makeContact() {
	const actor = await createTestActor({ name: `E2E Voice ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
	})
	const state = (n: number) =>
		clientState({ contact_id: contact.id, workspace_id: workspace.id, dial_attempt_n: n })
	// `attempt` is the dial attempt number the dialer stamps into client_state.
	const send = (type: string, call: string, extra: Record<string, unknown> = {}, attempt = 1) =>
		postTelnyxWebhook(
			telnyxEvent(type, { call_control_id: call, client_state: state(attempt), ...extra }),
		)
	const read = async () => {
		const o = await api.getObject(contact.id, workspace.id)
		return { status: o.status, metadata: (o.metadata ?? {}) as Record<string, unknown> }
	}
	return { send, read, contactId: contact.id }
}

/** Copenhagen weekday and time-of-day of an ISO instant. */
function copenhagen(iso: string) {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Copenhagen',
		weekday: 'short',
		hourCycle: 'h23',
		hour: '2-digit',
		minute: '2-digit',
	}).formatToParts(new Date(iso))
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
	return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

test.describe('Voice reducer: end to end', () => {
	test('no_answer: SMS trigger, retry one workday out inside the dial window, then the retry cap', async () => {
		const { send, read } = await makeContact()

		await send('call.initiated', 'c1')
		expect(await read()).toMatchObject({ status: 'voice_dialing' })

		await send('call.hangup', 'c1', { hangup_cause: 'no_answer' })
		const first = await read()
		expect(first.status).toBe('voice_no_answer')
		const next = String(first.metadata.next_dial_at)
		expect(new Date(next).getTime()).toBeGreaterThan(Date.now())
		const local = copenhagen(next)
		expect(['Sat', 'Sun']).not.toContain(local.weekday)
		expect(local.minutes).toBeGreaterThanOrEqual(9 * 60)
		expect(local.minutes).toBeLessThan(16 * 60)

		await send('call.initiated', 'c2', {}, 2)
		const second = (await read()).metadata
		expect(second).toMatchObject({ dial_attempt_n: 2, last_call_id: 'c2' })
		// the pending retry stamp is consumed once the retry is dialed (cleared or absent)
		expect(second.next_dial_at ?? null).toBeNull()
		await send('call.hangup', 'c2', { hangup_cause: 'no_answer' }, 2)
		expect((await read()).status).toBe('voice_no_answer')

		await send('call.initiated', 'c3', {}, 3)
		await send('call.hangup', 'c3', { hangup_cause: 'no_answer' }, 3)
		const last = await read()
		expect(last.status).toBe('voice_failed')
		expect(last.metadata.dial_attempt_n).toBe(3)
		expect(last.metadata.next_dial_at ?? null).toBeNull()
	})

	test('voicemail: machine result forces voicemail status and schedules a retry two workdays out', async () => {
		const { send, read } = await makeContact()
		await send('call.initiated', 'v1')
		await send('call.answered', 'v1')
		expect((await read()).status).toBe('voice_answered')

		await send('call.machine.premium.detection.ended', 'v1', { result: 'machine' })
		const after = await read()
		expect(after.status).toBe('voice_voicemail')
		expect(after.metadata.amd_result).toBe('machine')
		expect(new Date(String(after.metadata.next_dial_at)).getTime()).toBeGreaterThan(
			Date.now() + 24 * 60 * 60 * 1000,
		)

		// The hangup our forced hangup causes must not be processed a second time.
		const late = await send('call.hangup', 'v1', { hangup_cause: 'normal_clearing' })
		expect(late.json).toMatchObject({ applied: false })
		expect((await read()).status).toBe('voice_voicemail')
	})

	test('human AMD result stamps amd_result and leaves the call answered', async () => {
		const { send, read } = await makeContact()
		await send('call.initiated', 'h1')
		await send('call.answered', 'h1')
		await send('call.machine.premium.detection.ended', 'h1', { result: 'human' })
		const after = await read()
		expect(after.status).toBe('voice_answered')
		expect(after.metadata.amd_result).toBe('human')
	})

	test('declined: a connected call that ends with no booking is voice_declined and terminal', async () => {
		const { send, read } = await makeContact()
		await send('call.initiated', 'd1')
		await send('call.answered', 'd1')
		await send('call.hangup', 'd1', { hangup_cause: 'normal_clearing', duration_s: 40 })
		expect((await read()).status).toBe('voice_declined')

		// Terminal: a late event for the call does not move it again.
		await send('call.answered', 'd1')
		expect((await read()).status).toBe('voice_declined')
	})

	test('busy: voice_busy and requeued, a second busy fails the contact', async () => {
		const { send, read } = await makeContact()
		await send('call.initiated', 'b1')
		await send('call.hangup', 'b1', { hangup_cause: 'user_busy' })
		const first = await read()
		expect(first.status).toBe('voice_busy')
		expect(new Date(String(first.metadata.next_dial_at)).getTime()).toBeGreaterThan(Date.now())
		await send('call.initiated', 'b2', {}, 2)
		await send('call.hangup', 'b2', { hangup_cause: 'user_busy' }, 2)
		expect((await read()).status).toBe('voice_failed')
	})

	test('warm transfer completed is voice_warm_transferred and terminal', async () => {
		const { send, read } = await makeContact()
		await send('call.initiated', 't1')
		await send('call.answered', 't1')
		await send('call.transfer.completed', 't1', { target: '+4511223344' })
		expect((await read()).status).toBe('voice_warm_transferred')
		await send('call.hangup', 't1', { hangup_cause: 'normal_clearing' })
		expect((await read()).status).toBe('voice_warm_transferred')
	})
})
