import { expect, test } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'
import { clientState, postTelnyxWebhook, telnyxEvent } from '../helpers/telnyx.helper'

// The voice call tool router and the disclosure assertion (bet 5b8e), driven through the
// signed webhook route exactly as Telnyx would. The Calendar happy path needs a connected
// Google account, which E2E has none of, so booking is covered here through its failure path
// and through the unit and integration suites with a stubbed Calendar.

const CALL = 'tool-call-1'

async function makeContact(metadata: Record<string, unknown> = {}) {
	const actor = await createTestActor({ name: `E2E Voice tools ${Date.now()}` })
	const api = new TestAPI(actor.api_key)
	const workspace = (await api.listWorkspaces())[0]
	if (!workspace) throw new Error('No workspace found after actor creation')
	const contact = await api.createObject(workspace.id, {
		type: 'contact',
		title: 'Voice Prospect',
		status: 'voice_queued',
		metadata: { email: 'anna@example.dk', ...metadata },
	})
	const state = clientState({
		contact_id: contact.id,
		workspace_id: workspace.id,
		dial_attempt_n: 1,
	})
	const send = (type: string, extra: Record<string, unknown> = {}, call = CALL) =>
		postTelnyxWebhook(telnyxEvent(type, { call_control_id: call, client_state: state, ...extra }))
	const tool = async (name: string, input: Record<string, unknown>, call = CALL) =>
		(await send('assistant.tool_invocation', { tool_name: name, tool_input: input }, call)).json
	const read = async () => {
		const o = await api.getObject(contact.id, workspace.id)
		return { status: o.status, metadata: (o.metadata ?? {}) as Record<string, unknown> }
	}
	const startCall = async () => {
		await send('call.initiated')
		await send('call.answered')
	}
	return { send, tool, read, startCall }
}

const trace = (m: Record<string, unknown>) =>
	((m.voice_tool_trace as Array<{ tool_name: string }>) ?? []).map((e) => e.tool_name)

test.describe('Voice call tools: tool router', () => {
	test('rejects invalid input per tool and leaves no trace', async () => {
		const { tool, read, startCall } = await makeContact()
		await startCall()
		const cases: Array<[string, Record<string, unknown>]> = [
			['book_meeting_slot', { prospect_email: 'nope', prospect_name: 'Anna' }],
			['confirm_meeting_slot', { slot_index: 9, prospect_email: 'a@b.dk', prospect_name: 'A' }],
			['flag_interest', { strength: 'lukewarm', reason: 'x' }],
			['end_call_polite', {}],
			['request_followup_email', { prospect_quote: '' }],
			['request_followup_email', { prospect_quote: 'x'.repeat(281) }],
		]
		for (const [name, input] of cases) {
			expect(await tool(name, input), name).toMatchObject({ error: 'invalid_input' })
		}
		expect(trace((await read()).metadata)).toEqual([])
	})

	test('answers the five declared tools, and not_enabled for send_followup_sms', async () => {
		const { tool, read, startCall } = await makeContact()
		await startCall()
		expect(await tool('send_followup_sms', { mode: 'booking_link', message_body: 'hi' })).toEqual({
			error: 'not_enabled',
		})
		expect(await tool('lookup_contact_context', {})).toEqual({ error: 'unknown_tool' })
		expect(await tool('flag_interest', { strength: 'warm', reason: 'open to a talk' })).toEqual({
			acknowledged: true,
		})
		expect(await tool('end_call_polite', { reason: 'wrapping up' })).toEqual({
			acknowledged: true,
		})
		const meta = (await read()).metadata
		expect(trace(meta)).toEqual(['flag_interest', 'end_call_polite'])
		expect(meta.voice_end_reason).toBe('wrapping up')
	})

	test('a calendar failure on booking stamps followup_action and promises nothing', async () => {
		const { tool, read, startCall } = await makeContact()
		await startCall()
		const out = await tool('book_meeting_slot', {
			prospect_email: 'anna@example.dk',
			prospect_name: 'Anna',
		})
		expect(out).toEqual({ error: 'calendar_unavailable' })
		const meta = (await read()).metadata
		expect(meta.followup_action).toBe('email_calendar_link')
		expect(trace(meta)).toEqual([])
	})

	test('request_followup_email records the consent once and the call resolves to follow_up_later', async () => {
		const { tool, send, read, startCall } = await makeContact()
		await startCall()
		const input = {
			prospect_quote: 'Yes, send me the email',
			agent_line: 'One email from Maskin, you can opt out any time. Is that okay?',
		}
		expect(await tool('request_followup_email', input)).toEqual({ acknowledged: true })
		expect(await tool('request_followup_email', input)).toEqual({ acknowledged: true })
		expect(trace((await read()).metadata)).toEqual(['request_followup_email'])

		await send('call.hangup', {
			hangup_cause: 'normal_clearing',
			duration_s: 40,
			transcript: [
				{
					role: 'assistant',
					text: 'Hi Anna, this is an AI assistant calling on behalf of Maskin.',
				},
			],
		})
		expect((await read()).status).toBe('follow_up_later')
	})

	test('a request_followup_email with no agent line is not recorded', async () => {
		const { tool, read, startCall } = await makeContact()
		await startCall()
		expect(await tool('request_followup_email', { prospect_quote: 'yes please' })).toEqual({
			error: 'agent_line_required',
		})
		expect(trace((await read()).metadata)).toEqual([])
	})

	test('a tool call for a call that is not the current one does nothing', async () => {
		const { tool, read, startCall } = await makeContact()
		await startCall()
		expect(await tool('end_call_polite', { reason: 'x' }, 'some-other-call')).toEqual({
			error: 'call_not_current',
		})
		expect(trace((await read()).metadata)).toEqual([])
	})
})

test.describe('Voice call tools: AI disclosure assertion', () => {
	const hangup = (transcript: unknown) => ({
		hangup_cause: 'normal_clearing',
		duration_s: 30,
		transcript,
	})

	test('a hangup whose first utterance omits the AI-assistant phrase stamps the flag', async () => {
		const { send, read, startCall } = await makeContact()
		await startCall()
		await send(
			'call.hangup',
			hangup([
				{ role: 'assistant', text: 'Hi Anna, I would like to tell you about Maskin.' },
				{ role: 'user', text: 'Who is this?' },
			]),
		)
		expect((await read()).metadata.compliance_flag).toBe('disclosure_missing')
	})

	test('English and Danish openers that name an AI assistant leave no flag', async () => {
		for (const line of [
			'Hi Anna, this is an AI assistant calling on behalf of Maskin, do you have a moment?',
			'Hej Anna, det her er en AI-assistent, der ringer på vegne af Maskin, har du et øjeblik?',
		]) {
			const { send, read, startCall } = await makeContact()
			await startCall()
			await send('call.hangup', hangup([{ role: 'assistant', text: line }]))
			expect((await read()).metadata.compliance_flag).toBeUndefined()
		}
	})
})
