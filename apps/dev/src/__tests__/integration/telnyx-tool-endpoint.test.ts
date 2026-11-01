import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerToolHandler } from '../../lib/integrations/providers/telnyx/tool-dispatch'
import { createToolRouter } from '../../lib/integrations/providers/telnyx/tools'
import telnyxToolsRoutes from '../../routes/integrations-telnyx-tools'
import { insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const SECRET = 'test-tool-secret-value'
const PATH = '/api/integrations/telnyx/tools'
const CALL = 'call-plain-1'

let savedSecret: string | undefined
beforeAll(() => {
	savedSecret = process.env.TELNYX_TOOL_WEBHOOK_SECRET
})
afterAll(() => {
	if (savedSecret === undefined) Reflect.deleteProperty(process.env, 'TELNYX_TOOL_WEBHOOK_SECRET')
	else process.env.TELNYX_TOOL_WEBHOOK_SECRET = savedSecret
})
beforeEach(() => {
	process.env.TELNYX_TOOL_WEBHOOK_SECRET = SECRET
	registerToolHandler(
		createToolRouter({
			now: () => new Date('2026-10-05T09:30:00Z'),
			scriptVersion: () => 'hash-under-test',
			agentTurnFor: async () => null,
		}),
	)
})
afterEach(() => registerToolHandler(null))

function post(
	tool: string,
	body: unknown,
	headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
) {
	return createIntegrationApp({ path: PATH, module: telnyxToolsRoutes }).request(
		`${PATH}/${tool}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		},
	)
}

async function contactOnCall(callId = CALL) {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		status: 'voice_answered',
		metadata: { last_call_id: callId, voice_tool_trace: [], email: 'anna@example.dk' },
	})
	const read = async () => {
		const [row] = await db.select().from(objects).where(eq(objects.id, contact.id))
		return (row?.metadata ?? {}) as Record<string, unknown>
	}
	return { contact, read }
}

describe('Telnyx plain-POST tool endpoint: auth', () => {
	it('401 when the secret is not configured, even with a Bearer header', async () => {
		Reflect.deleteProperty(process.env, 'TELNYX_TOOL_WEBHOOK_SECRET')
		const res = await post('end_call_polite', { call_control_id: CALL, reason: 'x' })
		expect(res.status).toBe(401)
	})

	it('401 when the secret is configured as an empty string', async () => {
		process.env.TELNYX_TOOL_WEBHOOK_SECRET = '  '
		const res = await post(
			'end_call_polite',
			{ call_control_id: CALL, reason: 'x' },
			{ authorization: 'Bearer  ' },
		)
		expect(res.status).toBe(401)
	})

	it('401 with no header, a wrong secret, a wrong scheme, or a secret of another length', async () => {
		const body = { call_control_id: CALL, reason: 'x' }
		for (const headers of [
			{},
			{ authorization: 'Bearer wrong-secret-value-' },
			{ authorization: 'Bearer x' },
			{ authorization: `Basic ${SECRET}` },
			{ authorization: SECRET },
		] as Array<Record<string, string>>) {
			expect((await post('end_call_polite', body, headers)).status).toBe(401)
		}
	})

	it('does not touch the contact on a rejected request', async () => {
		const t = await contactOnCall('call-rejected')
		await post('end_call_polite', { call_control_id: 'call-rejected', reason: 'x' }, {})
		expect((await t.read()).voice_tool_trace).toEqual([])
	})
})

describe('Telnyx plain-POST tool endpoint: routing', () => {
	it('400 for a body that is not a JSON object, or has no call_control_id', async () => {
		expect((await post('end_call_polite', 'not json')).status).toBe(400)
		expect((await post('end_call_polite', [1, 2])).status).toBe(400)
		expect((await post('end_call_polite', { reason: 'x' })).status).toBe(400)
		expect((await post('end_call_polite', { call_control_id: '', reason: 'x' })).status).toBe(400)
	})

	it('resolves the contact from call_control_id and runs the tool with the rest of the body', async () => {
		const t = await contactOnCall('call-happy')
		const res = await post('end_call_polite', { call_control_id: 'call-happy', reason: 'bye' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ acknowledged: true })
		const m = await t.read()
		expect(m.voice_end_reason).toBe('bye')
		expect(m.voice_tool_trace).toEqual([expect.objectContaining({ tool_name: 'end_call_polite' })])
	})

	it('a replay for the same call adds no second trace entry', async () => {
		const t = await contactOnCall('call-replay')
		const body = { call_control_id: 'call-replay', reason: 'bye' }
		await post('end_call_polite', body)
		await post('end_call_polite', body)
		expect(((await t.read()).voice_tool_trace as unknown[]).length).toBe(1)
	})

	it('answers 200 call_not_current for a call id no contact is on', async () => {
		const res = await post('end_call_polite', { call_control_id: 'no-such-call', reason: 'x' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: 'call_not_current' })
	})

	it('hands Zod rejections back in the 200 body and leaves no trace', async () => {
		const t = await contactOnCall('call-bad-input')
		const res = await post('request_followup_email', {
			call_control_id: 'call-bad-input',
			prospect_quote: '',
			agent_line: 'x',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ error: 'invalid_input' })
		expect((await t.read()).voice_tool_trace).toEqual([])
	})

	it('answers not_enabled for send_followup_sms and unknown_tool for an undeclared name', async () => {
		await contactOnCall('call-names')
		const sms = await post('send_followup_sms', { call_control_id: 'call-names', mode: 'x' })
		expect(await sms.json()).toEqual({ error: 'not_enabled' })
		const other = await post('lookup_contact_context', { call_control_id: 'call-names' })
		expect(await other.json()).toEqual({ error: 'unknown_tool' })
	})
})
