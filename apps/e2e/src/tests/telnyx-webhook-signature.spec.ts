import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	clientState,
	postTelnyxWebhook,
	telnyxEvent,
	telnyxSignature,
} from '../helpers/telnyx.helper'

// Voice outreach webhook, signature and dedupe behaviour (bet 5b8e). Talks to the
// backend directly: no browser, the route is an external callback.

async function makeContact() {
	const actor = await createTestActor({ name: `E2E Telnyx ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
	})
	return { api, workspaceId: workspace.id, contactId: contact.id }
}

test.describe('Telnyx webhook: signature', () => {
	test('a good signature is accepted and moves the contact', async () => {
		const { api, workspaceId, contactId } = await makeContact()
		const res = await postTelnyxWebhook(
			telnyxEvent('call.initiated', {
				call_control_id: `cc-${contactId}`,
				client_state: clientState({
					contact_id: contactId,
					workspace_id: workspaceId,
					dial_attempt_n: 1,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const after = await api.getObject(contactId, workspaceId)
		expect(after.status).toBe('voice_dialing')
	})

	test('a missing signature is rejected with 401 and changes nothing', async () => {
		const { api, workspaceId, contactId } = await makeContact()
		const res = await postTelnyxWebhook(
			telnyxEvent('call.initiated', {
				call_control_id: `cc-${contactId}`,
				client_state: clientState({
					contact_id: contactId,
					workspace_id: workspaceId,
					dial_attempt_n: 1,
				}),
			}),
			{ unsigned: true },
		)
		expect(res.status).toBe(401)
		expect((await api.getObject(contactId, workspaceId)).status).toBe('voice_queued')
	})

	test('a bad signature is rejected with 401 and changes nothing', async () => {
		const { api, workspaceId, contactId } = await makeContact()
		const res = await postTelnyxWebhook(
			telnyxEvent('call.initiated', {
				call_control_id: `cc-${contactId}`,
				client_state: clientState({
					contact_id: contactId,
					workspace_id: workspaceId,
					dial_attempt_n: 1,
				}),
			}),
			{ signature: Buffer.alloc(64).toString('base64') },
		)
		expect(res.status).toBe(401)
		expect((await api.getObject(contactId, workspaceId)).status).toBe('voice_queued')
	})

	test('a replay outside the 300s window is rejected with 401, even when correctly signed', async () => {
		const { api, workspaceId, contactId } = await makeContact()
		const body = telnyxEvent('call.initiated', {
			call_control_id: `cc-${contactId}`,
			client_state: clientState({
				contact_id: contactId,
				workspace_id: workspaceId,
				dial_attempt_n: 1,
			}),
		})
		const res = await postTelnyxWebhook(body, { timestampOffsetSeconds: -301 })
		expect(res.status).toBe(401)
		expect((await api.getObject(contactId, workspaceId)).status).toBe('voice_queued')
		// sanity: the very same body inside the window is accepted
		expect((await postTelnyxWebhook(body, { timestampOffsetSeconds: -250 })).status).toBe(200)
	})

	test('a signature for a different body is rejected', async () => {
		const raw = JSON.stringify(telnyxEvent('call.answered', { call_control_id: 'x' }))
		const timestamp = String(Math.floor(Date.now() / 1000))
		const res = await fetch('http://localhost:3000/api/integrations/telnyx/webhook', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'telnyx-timestamp': timestamp,
				'telnyx-signature-ed25519': telnyxSignature('{"something":"else"}', timestamp),
			},
			body: raw,
		})
		expect(res.status).toBe(401)
	})

	test('an unknown event type is acknowledged with 200 and logged, not rejected', async () => {
		const res = await postTelnyxWebhook(
			telnyxEvent('call.some.future.event', { call_control_id: 'x' }),
		)
		expect(res.status).toBe(200)
		expect(res.json).toMatchObject({ skipped: true })
	})

	test('a duplicate event_id is acknowledged with 200 and has no side effects', async () => {
		const { api, workspaceId, contactId } = await makeContact()
		const body = telnyxEvent(
			'call.initiated',
			{
				call_control_id: `cc-${contactId}`,
				client_state: clientState({
					contact_id: contactId,
					workspace_id: workspaceId,
					dial_attempt_n: 1,
				}),
			},
			`dup-${contactId}`,
		)
		expect((await postTelnyxWebhook(body)).status).toBe(200)
		const first = await api.getObject(contactId, workspaceId)
		const again = await postTelnyxWebhook(body)
		expect(again.status).toBe(200)
		expect(again.json).toEqual({ ok: true, duplicate: true })
		const second = await api.getObject(contactId, workspaceId)
		expect(second.metadata).toEqual(first.metadata)
		expect(second.updatedAt).toBe(first.updatedAt)
	})
})
