import { type Server, createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	E2E_POSTHOG_STUB_PORT,
	clientState,
	postTelnyxWebhook,
	telnyxEvent,
} from '../helpers/telnyx.helper'

// The five voice PostHog events (bet 5b8e, spec 2b.5 step 10), end to end: signed
// Telnyx webhooks go in, and what the server actually sends to PostHog's ingestion
// endpoint is read off a stub server standing in for it. Events are keyed on the
// contact id (the distinct id), so each test reads only its own contact's traffic.
//
// post_call_email_sent has its positive case in the real-Postgres integration test
// (apps/dev/src/__tests__/integration/voice-posthog-events.test.ts): connecting a
// workspace Resend integration verifies the key against api.resend.com and needs a
// database seed, neither of which this suite has. Here the workspace has no Resend
// integration, which is the no_resend_integration skip: it must send no event.

interface Captured {
	event: string
	distinct_id: string
	properties: Record<string, unknown>
}

let stub: Server
let captured: Captured[] = []

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			try {
				const body = JSON.parse(raw) as Captured
				captured.push({
					event: body.event,
					distinct_id: body.distinct_id,
					properties: body.properties,
				})
			} catch {
				// Other server analytics may post here too; only voice events are read.
			}
			res.setHeader('Content-Type', 'application/json')
			res.end(JSON.stringify({ status: 1 }))
		})
	})
	await new Promise<void>((resolve) => stub.listen(E2E_POSTHOG_STUB_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()))
})

test.beforeEach(() => {
	captured = []
})

async function makeCall() {
	const actor = await createTestActor({ name: `E2E Voice PostHog ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
		metadata: { email: 'prospect@example.com' },
	})
	const call = `ph-${contact.id.slice(0, 8)}`
	const state = clientState({
		contact_id: contact.id,
		workspace_id: workspace.id,
		dial_attempt_n: 1,
	})
	const send = (type: string, extra: Record<string, unknown> = {}, id?: string) =>
		postTelnyxWebhook(
			telnyxEvent(
				type,
				{
					call_control_id: call,
					client_state: state,
					to: '+4511111111',
					from: '+4522222222',
					...extra,
				},
				id,
			),
		)
	const tool = (toolName: string, toolInput: Record<string, unknown> = {}) =>
		send('assistant.tool_invocation', { tool_name: toolName, tool_input: toolInput })

	// Emission is not awaited by the webhook, so wait for the expected count, then
	// give anything unexpected a moment to show up before the caller asserts on it.
	const events = async (expected: number) => {
		await expect.poll(() => mine().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(expected)
		await new Promise((resolve) => setTimeout(resolve, 400))
		return mine()
	}
	const mine = () =>
		captured
			.filter((c) => c.distinct_id === contact.id)
			.sort((a, b) => a.event.localeCompare(b.event))
	return { contactId: contact.id, send, tool, events }
}

test.describe('Voice PostHog events: end to end', () => {
	test('the spec walk fires call_initiated, call_answered, call_completed and meeting_booked with exact properties', async () => {
		const c = await makeCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('confirm_meeting_slot', { slot: '2026-10-08T09:00:00Z' })
		await c.tool('request_followup_email', { prospect_quote: 'yes, send it' })
		const hangup = await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 187 })
		expect(hangup.status).toBe(200)

		// No post_call_email_sent: this workspace has no Resend integration (see top).
		expect(await c.events(4)).toEqual([
			{ event: 'call_answered', distinct_id: c.contactId, properties: {} },
			{
				event: 'call_completed',
				distinct_id: c.contactId,
				properties: { outcome: 'answered', duration_seconds: 187, channel: 'voice_agent' },
			},
			{ event: 'call_initiated', distinct_id: c.contactId, properties: {} },
			{
				event: 'meeting_booked',
				distinct_id: c.contactId,
				properties: { source: 'voice_agent', contact_id: c.contactId },
			},
		])
	})

	test('a replayed event (same event_id) does not fire anything twice', async () => {
		const c = await makeCall()
		await c.send('call.initiated', {}, 'ph-dup-initiated')
		await c.send('call.initiated', {}, 'ph-dup-initiated')
		await c.send('call.answered', {}, 'ph-dup-answered')
		await c.send('call.answered', {}, 'ph-dup-answered')
		await c.send(
			'call.hangup',
			{ hangup_cause: 'normal_clearing', duration_s: 12 },
			'ph-dup-hangup',
		)
		const replay = await c.send(
			'call.hangup',
			{ hangup_cause: 'normal_clearing', duration_s: 12 },
			'ph-dup-hangup',
		)
		expect(replay.json).toMatchObject({ duplicate: true })

		expect((await c.events(3)).map((e) => e.event)).toEqual([
			'call_answered',
			'call_completed',
			'call_initiated',
		])
	})

	test('no connected leg: call_completed is no_answer with duration 0 and nothing else follows', async () => {
		const c = await makeCall()
		await c.send('call.initiated')
		await c.send('call.hangup', { hangup_cause: 'no_answer', duration_s: 31 })

		expect(await c.events(2)).toEqual([
			{
				event: 'call_completed',
				distinct_id: c.contactId,
				properties: { outcome: 'no_answer', duration_seconds: 0, channel: 'voice_agent' },
			},
			{ event: 'call_initiated', distinct_id: c.contactId, properties: {} },
		])
	})

	test('a machine pickup is voicemail', async () => {
		const c = await makeCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.send('call.machine.premium.detection.ended', { result: 'machine' })
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 9 })

		const events = await c.events(3)
		expect(events.find((e) => e.event === 'call_completed')?.properties).toEqual({
			outcome: 'voicemail',
			duration_seconds: 9,
			channel: 'voice_agent',
		})
		expect(events.map((e) => e.event)).not.toContain('meeting_booked')
	})

	test('a connected call with no request_followup_email in the trace is answered and sends no email event', async () => {
		const c = await makeCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('end_call_polite')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 44 })

		expect(await c.events(3)).toEqual([
			{ event: 'call_answered', distinct_id: c.contactId, properties: {} },
			{
				event: 'call_completed',
				distinct_id: c.contactId,
				properties: { outcome: 'answered', duration_seconds: 44, channel: 'voice_agent' },
			},
			{ event: 'call_initiated', distinct_id: c.contactId, properties: {} },
		])
	})
})
