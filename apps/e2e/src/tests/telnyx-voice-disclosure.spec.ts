import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { clientState, postTelnyxWebhook, telnyxEvent } from '../helpers/telnyx.helper'

// The AI-disclosure assertion at hangup (tech spec section 7a, bet 5b8e): the first thing the
// agent said on a connected call must carry the AI-assistant phrase, or the contact is flagged
// and the follow-up email stays blocked.

async function connectedCall(transcript: unknown) {
	const actor = await createTestActor({ name: `E2E Voice disclosure ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
	})
	const state = clientState({
		contact_id: contact.id,
		workspace_id: workspace.id,
		dial_attempt_n: 1,
	})
	const callId = `disclosure-${Date.now()}`
	const send = (type: string, extra: Record<string, unknown> = {}) =>
		postTelnyxWebhook(telnyxEvent(type, { call_control_id: callId, client_state: state, ...extra }))
	await send('call.initiated')
	await send('call.answered')
	const hangup = await send('call.hangup', {
		hangup_cause: 'normal_clearing',
		duration_s: 61,
		transcript,
	})
	expect(hangup.status).toBe(200)
	return (await api.getObject(contact.id, workspace.id)).metadata as Record<string, unknown>
}

test.describe('Voice disclosure assertion: end to end', () => {
	test('a first utterance without the AI-assistant phrase stamps disclosure_missing', async () => {
		const metadata = await connectedCall([
			{ role: 'assistant', text: 'Hi Pia, this is Sebastian from Maskin, do you have a moment?' },
			{ role: 'user', text: 'Sure' },
			{ role: 'assistant', text: 'By the way, I am an AI assistant.' },
		])
		expect(metadata.compliance_flag).toBe('disclosure_missing')
	})

	test('the English opener with the phrase passes', async () => {
		const metadata = await connectedCall([
			{
				role: 'assistant',
				text: 'Hi Pia, this is an AI assistant calling on behalf of Maskin, do you have a moment?',
			},
		])
		expect(metadata.compliance_flag).toBeUndefined()
	})

	test('the Danish opener with AI-assistent passes', async () => {
		const metadata = await connectedCall([
			{
				role: 'assistant',
				text: 'Hej Pia, det her er en AI-assistent, der ringer på vegne af Maskin, har du et øjeblik?',
			},
		])
		expect(metadata.compliance_flag).toBeUndefined()
	})

	test('a connected call whose transcript carries no agent utterance is flagged, because disclosure cannot be shown', async () => {
		const metadata = await connectedCall(undefined)
		expect(metadata.compliance_flag).toBe('disclosure_missing')
	})
})
