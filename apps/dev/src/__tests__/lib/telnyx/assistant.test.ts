import { describe, expect, it, vi } from 'vitest'
import {
	ASSISTANT_MODEL,
	CONFIRM_EMAIL_DA,
	CONFIRM_EMAIL_EN,
	CONVERSATION_FLOW,
	DECLARED_TOOLS,
	DISCLOSURE_DA,
	DISCLOSURE_EN,
	SCRIPT_VERSION,
	SYSTEM_PROMPT,
	assistantContentHash,
	buildAssistantPayload,
	renderDisclosure,
	syncAssistant,
} from '../../../lib/integrations/providers/telnyx/assistant'
import type {
	AssistantRecord,
	TelnyxClient,
} from '../../../lib/integrations/providers/telnyx/client'
import { TOOL_NAMES, toolInputSchemas } from '../../../lib/integrations/providers/telnyx/tools'
import { DISCLOSURE_PATTERNS, isDisclosure } from '../../../lib/outreach/voice/call-hooks'

const URL = 'https://maskin.example/api/integrations/telnyx/webhook'

describe('assistant payload', () => {
	it('declares exactly the five tools and no SMS tool', () => {
		expect(DECLARED_TOOLS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
		expect(DECLARED_TOOLS).toHaveLength(5)
		expect(JSON.stringify(buildAssistantPayload({ webhookUrl: URL }))).not.toContain(
			'send_followup_sms',
		)
	})

	it('describes request_followup_email as the strict confirm-then-yes tool', () => {
		const tool = DECLARED_TOOLS.find((t) => t.name === 'request_followup_email')
		expect(tool?.description).toContain('Call only after the prospect raised email themselves')
		expect(tool?.description).toContain(
			'you confirmed the address and told them they can opt out any time',
		)
		expect(tool?.description).toContain('they said yes')
		expect(tool?.description).toContain('Pass their words')
		expect(tool?.description).toContain('Never call it to offer or to be helpful')
		expect(tool?.description).not.toMatch(/asks for an email|says yes to receiving/i)
	})

	it('keeps each declared JSON schema in step with its Zod input', () => {
		for (const tool of DECLARED_TOOLS) {
			const zod = toolInputSchemas[tool.name as keyof typeof toolInputSchemas]
			const zodKeys = Object.keys(zod.shape).sort()
			expect(Object.keys(tool.parameters.properties).sort(), tool.name).toEqual(zodKeys)
			const requiredByZod = Object.entries(zod.shape)
				.filter(([, v]) => !(v as { isOptional(): boolean }).isOptional())
				.map(([k]) => k)
				.sort()
			expect([...tool.parameters.required].sort(), tool.name).toEqual(requiredByZod)
		}
	})

	it('uses the model and puts a Speak node first, with no model turn before it', () => {
		const payload = buildAssistantPayload({ webhookUrl: URL })
		expect(payload.model).toBe(ASSISTANT_MODEL)
		expect(ASSISTANT_MODEL).toBe('anthropic/claude-haiku-4-5')
		expect(CONVERSATION_FLOW.start_node).toBe('disclosure')
		expect(CONVERSATION_FLOW.nodes[0]).toMatchObject({ type: 'speak', text: '{{disclosure_text}}' })
		expect(payload).not.toHaveProperty('greeting')
	})

	it('renders the Danish and English disclosure so the hangup assertion would accept both', () => {
		const en = renderDisclosure('en', 'Pia')
		const da = renderDisclosure('da', 'Pia')
		expect(en).toBe(DISCLOSURE_EN.replace('{{prospect_first_name}}', 'Pia'))
		expect(da).toBe(DISCLOSURE_DA.replace('{{prospect_first_name}}', 'Pia'))
		expect(isDisclosure(en)).toBe(true)
		expect(isDisclosure(da)).toBe(true)
		expect(DISCLOSURE_PATTERNS).toHaveLength(2)
		expect(isDisclosure('Hi Pia, this is Sebastian from Maskin')).toBe(false)
	})

	it('carries the confirm-then-wait email sequence and the strict calendar fallback, and never offers', () => {
		expect(SYSTEM_PROMPT).toContain('Available actions (five tools)')
		expect(SYSTEM_PROMPT).toContain(CONFIRM_EMAIL_EN)
		expect(SYSTEM_PROMPT).toContain(CONFIRM_EMAIL_DA)
		expect(SYSTEM_PROMPT).toContain('Never offer to send an email')
		expect(SYSTEM_PROMPT).toContain('You never offer an email')
		expect(SYSTEM_PROMPT).toContain(
			'Never call the tool before you have spoken the confirmation line',
		)
		expect(SYSTEM_PROMPT).toContain(
			'tell the prospect the booking did not go through and stop there',
		)
		expect(SYSTEM_PROMPT).toContain('Never promise an email, a text or a call-back')
		expect(SYSTEM_PROMPT).not.toContain('send_followup_sms')
		expect(SYSTEM_PROMPT).not.toMatch(/want me to email/i)
	})

	it('hashes the script, not the environment: the webhook URL and tool ids do not move it', () => {
		expect(SCRIPT_VERSION).toBe(assistantContentHash())
		expect(SCRIPT_VERSION).toMatch(/^[0-9a-f]{64}$/)
		const a = buildAssistantPayload({ webhookUrl: URL, toolIds: ['t1'] })
		const b = buildAssistantPayload({ webhookUrl: 'https://other.example/hook' })
		expect(a.description).toBe(`maskin-script:${SCRIPT_VERSION}`)
		expect(b.description).toBe(a.description)
	})
})

function fakeClient(existing: AssistantRecord | null) {
	const calls: string[] = []
	const client = {
		getAssistant: vi.fn(async () => existing),
		createAssistant: vi.fn(async () => {
			calls.push('create')
			return { id: 'new-id', description: null, toolIds: [] }
		}),
		updateAssistant: vi.fn(async (id: string) => {
			calls.push(`update:${id}`)
			return { id, description: null, toolIds: [] }
		}),
	} as unknown as TelnyxClient
	return { client, calls }
}

describe('syncAssistant', () => {
	it('creates the assistant when none exists', async () => {
		const { client, calls } = fakeClient(null)
		expect(await syncAssistant(client, { assistantId: null, webhookUrl: URL })).toEqual({
			action: 'created',
			assistantId: 'new-id',
		})
		expect(calls).toEqual(['create'])
	})

	it('creates when the configured id no longer exists on Telnyx', async () => {
		const { client } = fakeClient(null)
		const r = await syncAssistant(client, { assistantId: 'gone', webhookUrl: URL })
		expect(r.action).toBe('created')
	})

	it('does nothing when the content hash and tools already match', async () => {
		const { client, calls } = fakeClient({
			id: 'a1',
			description: `maskin-script:${SCRIPT_VERSION}`,
			toolIds: ['kb-1'],
		})
		const r = await syncAssistant(client, { assistantId: 'a1', webhookUrl: URL, toolIds: ['kb-1'] })
		expect(r).toEqual({ action: 'unchanged', assistantId: 'a1' })
		expect(calls).toEqual([])
	})

	it('updates when the script hash differs', async () => {
		const { client, calls } = fakeClient({
			id: 'a1',
			description: 'maskin-script:old',
			toolIds: [],
		})
		expect((await syncAssistant(client, { assistantId: 'a1', webhookUrl: URL })).action).toBe(
			'updated',
		)
		expect(calls).toEqual(['update:a1'])
	})

	it('updates when only the attached tools differ', async () => {
		const { client, calls } = fakeClient({
			id: 'a1',
			description: `maskin-script:${SCRIPT_VERSION}`,
			toolIds: [],
		})
		const r = await syncAssistant(client, { assistantId: 'a1', webhookUrl: URL, toolIds: ['kb-1'] })
		expect(r.action).toBe('updated')
		expect(calls).toEqual(['update:a1'])
	})
})
