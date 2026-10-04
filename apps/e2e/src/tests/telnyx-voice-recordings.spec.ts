import { type Server, createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import {
	E2E_TELNYX_STUB_PORT,
	E2E_TELNYX_STUB_URL,
	clientState,
	postTelnyxWebhook,
	telnyxEvent,
} from '../helpers/telnyx.helper'

// Call recording mirror, then erasure (bet 5b8e). A signed hangup webhook starts the
// mirror; Telnyx's REST API and the pre-signed file host are one stub server. The dev
// server runs the retention sweep every 2s (playwright.config.ts), so setting a
// contact to deleted_by_request is observed within a few seconds.

let stub: Server
const lookups: string[] = []

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		const url = req.url ?? ''
		if (url.startsWith('/v2/recordings')) {
			lookups.push(url)
			res.setHeader('Content-Type', 'application/json')
			res.end(
				JSON.stringify({
					data: [
						{
							id: 'rec-e2e-1',
							status: 'completed',
							download_urls: { mp3: `${E2E_TELNYX_STUB_URL}/files/rec.mp3` },
						},
					],
				}),
			)
			return
		}
		if (url === '/files/rec.mp3') {
			res.setHeader('Content-Type', 'audio/mpeg')
			res.end(Buffer.from('e2e-mp3-bytes'))
			return
		}
		if (url === '/files/transcript.json') {
			res.setHeader('Content-Type', 'application/json')
			res.end(JSON.stringify({ turns: [{ role: 'assistant', text: 'Hi, this is an AI caller.' }] }))
			return
		}
		res.statusCode = 404
		res.end('{}')
	})
	await new Promise<void>((resolve) => stub.listen(E2E_TELNYX_STUB_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()))
})

test.describe('Voice recordings: mirror then erasure', () => {
	test('a declined call is mirrored and stamped, and an erasure request wipes it on the next sweep', async () => {
		const actor = await createTestActor({ name: `E2E Voice recordings ${Date.now()}` })
		const api = new TestAPI(actor.api_key)
		const workspace = (await api.listWorkspaces())[0]
		if (!workspace) throw new Error('No workspace found after actor creation')
		const contact = await api.createObject(workspace.id, {
			type: 'contact',
			title: 'Recorded Prospect',
			status: 'voice_queued',
			content: 'Head of ops, mobile +4511111111',
			metadata: {
				email: 'recorded@prospect.example',
				consent_call_id: 'rec-call-1',
				consent_basis: 'gdpr_6_1_f',
			},
		})
		const state = clientState({
			contact_id: contact.id,
			workspace_id: workspace.id,
			dial_attempt_n: 1,
		})
		const send = (type: string, extra: Record<string, unknown> = {}) =>
			postTelnyxWebhook(
				telnyxEvent(type, { call_control_id: 'rec-call-1', client_state: state, ...extra }),
			)
		const read = async () => {
			const o = await api.getObject(contact.id, workspace.id)
			return {
				status: o.status,
				content: (o as { content?: string | null }).content ?? null,
				metadata: (o.metadata ?? {}) as Record<string, unknown>,
			}
		}

		await send('call.initiated')
		await send('call.answered')
		const endedAt = new Date().toISOString()
		const hangup = await send('call.hangup', {
			hangup_cause: 'normal_clearing',
			end_time: endedAt,
			transcript_url: `${E2E_TELNYX_STUB_URL}/files/transcript.json`,
		})
		// The mirror is background work: the webhook answers without waiting for it.
		expect(hangup.status).toBe(200)
		expect((await read()).status).toBe('voice_declined')

		await expect
			.poll(async () => (await read()).metadata.last_call_recording_id, { timeout: 30_000 })
			.toBe(`voice-outreach/${contact.id}/rec-call-1.mp3`)
		const mirrored = await read()
		expect(mirrored.metadata).toMatchObject({
			last_call_transcript_id: `voice-outreach/${contact.id}/rec-call-1.json`,
			voice_last_touch_at: endedAt,
			voice_first_touch_at: endedAt,
		})
		const expiry = new Date(String(mirrored.metadata.retention_expires_at))
		const last = new Date(endedAt)
		expect(expiry.getUTCFullYear()).toBe(last.getUTCFullYear() + 2)
		expect(lookups.some((u) => u.includes('rec-call-1'))).toBe(true)

		await api.updateObject(contact.id, workspace.id, { status: 'deleted_by_request' })

		await expect
			.poll(async () => (await read()).metadata.erased_at, { timeout: 30_000 })
			.toBeTruthy()
		const erased = await read()
		expect(erased.status).toBe('deleted_by_request')
		expect(erased.content).toBeNull()
		expect(erased.metadata.email).toBeUndefined()
		expect(erased.metadata.last_call_recording_id).toBeUndefined()
		expect(erased.metadata.voice_last_touch_at).toBeUndefined()
		// Consent evidence is not on the erasure clock.
		expect(erased.metadata).toMatchObject({
			consent_call_id: 'rec-call-1',
			consent_basis: 'gdpr_6_1_f',
		})
	})
})
