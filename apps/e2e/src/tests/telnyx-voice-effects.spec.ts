import { type Server, createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	E2E_TELNYX_STUB_PORT,
	clientState,
	postTelnyxWebhook,
	telnyxEvent,
} from '../helpers/telnyx.helper'

// What the voice reducer DOES to Telnyx (bet 5b8e): the SMS it fires and the
// forced hangup on an AMD machine. Telnyx's REST API is a stub server here; the
// status walks themselves are covered in telnyx-voice-reducer.spec.ts.

interface StubRequest {
	method: string
	url: string
	body: Record<string, unknown>
}

let stub: Server
let requests: StubRequest[] = []

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			requests.push({
				method: req.method ?? '',
				url: req.url ?? '',
				body: raw ? JSON.parse(raw) : {},
			})
			res.setHeader('Content-Type', 'application/json')
			res.end(JSON.stringify({ data: { id: 'stub-message-1' } }))
		})
	})
	await new Promise<void>((resolve) => stub.listen(E2E_TELNYX_STUB_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()))
})

test.beforeEach(() => {
	requests = []
})

async function makeContact() {
	const actor = await createTestActor({ name: `E2E Voice effects ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
	})
	const send = (type: string, call: string, extra: Record<string, unknown> = {}) =>
		postTelnyxWebhook(
			telnyxEvent(type, {
				call_control_id: call,
				client_state: clientState({
					contact_id: contact.id,
					workspace_id: workspace.id,
					dial_attempt_n: 1,
				}),
				to: '+4511111111',
				from: '+4522222222',
				...extra,
			}),
		)
	const status = async () => (await api.getObject(contact.id, workspace.id)).status
	return { send, status }
}

const smsRequests = () => requests.filter((r) => r.url === '/v2/messages')

test.describe('Voice reducer: Telnyx side effects', () => {
	test('no_answer sends the missed-call SMS from our number to the prospect', async () => {
		const { send, status } = await makeContact()
		await send('call.initiated', 'fx-na')
		await send('call.hangup', 'fx-na', { hangup_cause: 'no_answer' })
		expect(await status()).toBe('voice_no_answer')

		expect(smsRequests()).toHaveLength(1)
		expect(smsRequests()[0]?.body).toMatchObject({
			from: '+4522222222',
			to: '+4511111111',
			text: 'e2e missed call nudge',
		})
	})

	test('AMD machine forces the hangup and sends the voicemail SMS, once', async () => {
		const { send, status } = await makeContact()
		await send('call.initiated', 'fx-vm')
		await send('call.answered', 'fx-vm')
		await send('call.machine.premium.detection.ended', 'fx-vm', { result: 'machine' })
		expect(await status()).toBe('voice_voicemail')

		expect(requests.filter((r) => r.url === '/v2/calls/fx-vm/actions/hangup')).toHaveLength(1)
		expect(smsRequests()).toHaveLength(1)
		expect(smsRequests()[0]?.body).toMatchObject({ text: 'e2e voicemail followup' })

		// The hangup our own request causes must not fire a second SMS.
		await send('call.hangup', 'fx-vm', { hangup_cause: 'normal_clearing' })
		expect(smsRequests()).toHaveLength(1)
	})

	test('a declined call and a human AMD result send nothing', async () => {
		const { send } = await makeContact()
		await send('call.initiated', 'fx-h')
		await send('call.answered', 'fx-h')
		await send('call.machine.premium.detection.ended', 'fx-h', { result: 'human' })
		await send('call.hangup', 'fx-h', { hangup_cause: 'normal_clearing' })
		expect(requests).toHaveLength(0)
	})
})
