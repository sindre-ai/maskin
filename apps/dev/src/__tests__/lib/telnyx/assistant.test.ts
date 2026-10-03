import { describe, expect, it, vi } from 'vitest'
import {
	DISCLOSURE_PATTERNS,
	DISCLOSURE_TEMPLATES,
	SYSTEM_PROMPT,
	assistantContentHash,
	buildAssistantPayload,
	ensureAssistant,
} from '../../../lib/integrations/providers/telnyx/assistant'
import type { TelnyxClient } from '../../../lib/integrations/providers/telnyx/client'
import {
	DECLARED_TOOL_NAMES,
	TOOL_DECLARATIONS,
} from '../../../lib/integrations/providers/telnyx/tool-schemas'

const input = {
	locale: 'da',
	toolWebhookUrl: 'https://maskin.test/api/integrations/telnyx/webhook',
} as const

describe('buildAssistantPayload', () => {
	const payload = buildAssistantPayload(input) as {
		model: string
		tools: Array<{ type: string; webhook: { name: string; description: string } }>
		conversation_flow: {
			start_node_id: string
			nodes: Array<{ id: string; type: string; message?: string }>
		}
	}

	it('uses claude-haiku-4-5', () => {
		expect(payload.model).toBe('anthropic/claude-haiku-4-5')
	})

	it('declares exactly the five tools and no SMS tool', () => {
		const names = payload.tools.map((t) => t.webhook.name)
		expect(names).toEqual([...DECLARED_TOOL_NAMES])
		expect(names).toHaveLength(5)
		expect(names).not.toContain('send_followup_sms')
		expect(JSON.stringify(payload)).not.toContain('send_followup_sms')
	})

	it('starts the conversation flow on a Speak node holding the disclosure verbatim', () => {
		const first = payload.conversation_flow.nodes.find(
			(n) => n.id === payload.conversation_flow.start_node_id,
		)
		expect(first?.type).toBe('speak')
		expect(first?.message).toBe(DISCLOSURE_TEMPLATES.da)
		expect(DISCLOSURE_PATTERNS.some((re) => re.test(first?.message ?? ''))).toBe(true)
	})

	it('both disclosure variants satisfy the hangup assertion patterns', () => {
		for (const text of Object.values(DISCLOSURE_TEMPLATES)) {
			expect(DISCLOSURE_PATTERNS.some((re) => re.test(text))).toBe(true)
		}
	})

	it('carries the request_followup_email consent condition in its description', () => {
		const desc =
			payload.tools.find((t) => t.webhook.name === 'request_followup_email')?.webhook.description ??
			''
		expect(desc).toContain('raised email themselves')
		expect(desc).toContain('opt out any time')
		expect(desc).toContain('said yes')
		expect(desc).toContain('Never call it to offer')
	})

	it('system prompt lists five tools, never offers email or text, and keeps the strict fallback', () => {
		expect(SYSTEM_PROMPT).toContain('Available actions (five tools)')
		expect(SYSTEM_PROMPT).toContain('Never offer to send an email')
		expect(SYSTEM_PROMPT).toContain('promise nothing outbound')
		expect(SYSTEM_PROMPT).toContain('opt out at any time')
		expect(SYSTEM_PROMPT).not.toContain('send_followup_sms')
		expect(TOOL_DECLARATIONS).toHaveLength(5)
	})
})

describe('assistantContentHash', () => {
	it('is stable across key order and changes with content', () => {
		const a = buildAssistantPayload(input)
		const reordered = Object.fromEntries(Object.entries(a).reverse())
		expect(assistantContentHash(reordered)).toBe(assistantContentHash(a))
		expect(assistantContentHash(buildAssistantPayload({ ...input, locale: 'en' }))).not.toBe(
			assistantContentHash(a),
		)
	})

	it('ignores the description field, where the hash itself is stored', () => {
		const a = buildAssistantPayload(input)
		expect(assistantContentHash({ ...a, description: 'whatever' })).toBe(assistantContentHash(a))
	})
})

describe('ensureAssistant', () => {
	function fake(existing: { id: string; description: string | null } | null) {
		const client = {
			getAssistant: vi.fn(async () => (existing ? { ...existing, toolIds: [] } : null)),
			createAssistant: vi.fn(async () => ({ id: 'asst-new', description: null, toolIds: [] })),
			updateAssistant: vi.fn(async (id: string) => ({ id, description: null, toolIds: [] })),
		}
		return client as unknown as TelnyxClient & typeof client
	}
	const payload = buildAssistantPayload(input)

	it('creates the assistant when none exists', async () => {
		const client = fake(null)
		const res = await ensureAssistant(client, { assistantId: null, payload })
		expect(res.action).toBe('created')
		expect(client.createAssistant).toHaveBeenCalledTimes(1)
	})

	it('updates when the stored hash differs, and makes no write when it matches', async () => {
		const stale = fake({ id: 'asst-1', description: 'maskin-voice-assistant:old' })
		expect((await ensureAssistant(stale, { assistantId: 'asst-1', payload })).action).toBe(
			'updated',
		)
		expect(stale.updateAssistant).toHaveBeenCalledTimes(1)

		const hash = assistantContentHash(payload)
		const current = fake({ id: 'asst-1', description: `maskin-voice-assistant:${hash}` })
		const res = await ensureAssistant(current, { assistantId: 'asst-1', payload })
		expect(res.action).toBe('unchanged')
		expect(current.updateAssistant).not.toHaveBeenCalled()
		expect(current.createAssistant).not.toHaveBeenCalled()
	})
})
