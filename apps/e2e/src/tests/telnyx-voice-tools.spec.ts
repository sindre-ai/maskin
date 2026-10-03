import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { clientState, postTelnyxWebhook, telnyxEvent } from '../helpers/telnyx.helper'

// The voice tool router, end to end through the signed webhook route (bet 5b8e): each tool is
// invoked as an assistant.tool_invocation event and answers in the 200 body. Google Calendar
// has no connection in this workspace, so the booking tools exercise the strict fallback; the
// Calendar happy path (a real events.insert) is covered by the integration suite with an
// injected client, because the Calendar REST origin is not overridable here.

async function makeCall(metadata: Record<string, unknown> = {}) {
	const actor = await createTestActor({ name: `E2E Voice tools ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
		metadata: { email: 'prospect@example.com', ...metadata },
	})
	const state = clientState({
		contact_id: contact.id,
		workspace_id: workspace.id,
		dial_attempt_n: 1,
	})
	const callId = `tools-${Date.now()}`
	const send = (type: string, extra: Record<string, unknown> = {}) =>
		postTelnyxWebhook(telnyxEvent(type, { call_control_id: callId, client_state: state, ...extra }))
	const tool = async (tool_name: string, tool_input: Record<string, unknown>) => {
		const res = await send('assistant.tool_invocation', { tool_name, tool_input })
		expect(res.status).toBe(200)
		return res.json as Record<string, unknown>
	}
	const read = async () => {
		const o = await api.getObject(contact.id, workspace.id)
		return { status: o.status, metadata: (o.metadata ?? {}) as Record<string, unknown> }
	}
	const trace = async () =>
		(((await read()).metadata.voice_tool_trace ?? []) as Array<{ tool_name: string }>).map(
			(e) => e.tool_name,
		)
	await send('call.initiated')
	await send('call.answered')
	return { tool, read, trace, send }
}

const PROSPECT = { prospect_email: 'prospect@example.com', prospect_name: 'Pia Prospect' }

test.describe('Voice tool router: end to end', () => {
	test('rejects invalid input for each of the five tools and writes nothing', async () => {
		const { tool, trace } = await makeCall()
		const bad: Array<[string, Record<string, unknown>]> = [
			['book_meeting_slot', {}],
			['confirm_meeting_slot', { slot_index: 7, ...PROSPECT }],
			['flag_interest', { strength: 'lukewarm', reason: 'x' }],
			['end_call_polite', {}],
			['request_followup_email', { prospect_quote: 'x'.repeat(281) }],
		]
		for (const [name, input] of bad) {
			expect(await tool(name, input), name).toMatchObject({ error: 'invalid_input' })
		}
		expect(await trace()).toEqual([])
	})

	test('answers not_enabled for send_followup_sms and does nothing else', async () => {
		const { tool, trace } = await makeCall()
		expect(
			await tool('send_followup_sms', { message_body: 'hi', mode: 'booking_link' }),
		).toMatchObject({ error: 'not_enabled' })
		expect(await trace()).toEqual([])
	})

	test('end_call_polite records the reason and the trace entry', async () => {
		const { tool, read, trace } = await makeCall()
		expect(await tool('end_call_polite', { reason: 'not interested' })).toEqual({
			acknowledged: true,
		})
		expect((await read()).metadata.voice_end_reason).toBe('not interested')
		expect(await trace()).toEqual(['end_call_polite'])
	})

	test('flag_interest warm records the interest for the hangup ping', async () => {
		const { tool, read } = await makeCall()
		expect(await tool('flag_interest', { strength: 'warm', reason: 'open to a meeting' })).toEqual({
			acknowledged: true,
		})
		expect((await read()).metadata.voice_interest).toMatchObject({
			strength: 'warm',
			reason: 'open to a meeting',
			ping: 'pending',
		})
	})

	test('a booking with no Google Calendar connected says so, stamps followup_action and writes no voice_meeting', async () => {
		const { tool, read, trace } = await makeCall()
		const out = await tool('book_meeting_slot', PROSPECT)
		expect(out).toMatchObject({ error: 'calendar_unavailable' })
		expect(String(out.message)).toContain('did not go through')
		const { metadata } = await read()
		expect(metadata.followup_action).toBe('email_calendar_link')
		expect(metadata.voice_meeting).toBeUndefined()
		expect(await trace()).toEqual([])
	})

	test('request_followup_email: one trace entry on the yes, none for the replay, and the contact resolves to follow_up_later', async () => {
		const { tool, send, read, trace } = await makeCall()
		expect(await tool('request_followup_email', { prospect_quote: 'yes, that is fine' })).toEqual({
			acknowledged: true,
		})
		expect(await tool('request_followup_email', { prospect_quote: 'yes, that is fine' })).toEqual({
			acknowledged: true,
		})
		expect(await trace()).toEqual(['request_followup_email'])
		await send('call.hangup', {
			hangup_cause: 'normal_clearing',
			duration_s: 42,
			transcript: [
				{ role: 'assistant', text: 'Hi Pia, this is an AI assistant calling on behalf of Maskin' },
			],
		})
		expect((await read()).status).toBe('follow_up_later')
	})

	test('request_followup_email on a contact with no email address records nothing', async () => {
		const { tool, trace } = await makeCall({ email: null })
		expect(await tool('request_followup_email', { prospect_quote: 'yes' })).toMatchObject({
			error: 'no_contact_email',
		})
		expect(await trace()).toEqual([])
	})
})
