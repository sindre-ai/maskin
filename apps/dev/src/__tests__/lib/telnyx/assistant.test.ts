import { describe, expect, it, vi } from 'vitest'
import {
	ASSISTANT_FIRST_NAME,
	DISCLOSURE_PATTERNS,
	DISCLOSURE_TEMPLATES,
	SYSTEM_PROMPT,
	assistantContentHash,
	buildAssistantPayload,
	currentScriptVersion,
	ensureAssistant,
} from '../../../lib/integrations/providers/telnyx/assistant'
import type { TelnyxClient } from '../../../lib/integrations/providers/telnyx/client'
import {
	DECLARED_TOOL_NAMES,
	TOOL_DECLARATIONS,
} from '../../../lib/integrations/providers/telnyx/tool-schemas'
import live from './fixtures/rune-live-assistant.json'

interface BuiltPayload {
	model: string
	name: string
	instructions: string
	tools: Array<{
		type: string
		webhook: {
			name: string
			description: string
			url: string
			method: string
			headers: Array<{ name: string; value: string }>
			timeout_ms: number
			async: boolean
			body_parameters: { properties: Record<string, unknown>; required: string[] }
			preset_body_fields: Record<string, string>
		}
	}>
	conversation_flow: {
		start_node_id: string
		nodes: Array<{
			id: string
			type: string
			name: string
			message?: string
			instructions?: string
			instructions_mode?: string
		}>
		edges: unknown[]
	}
}

const input = {
	locale: 'da',
	toolWebhookSecret: 'test-secret',
	toolsBaseUrl: 'https://maskin.test/api/integrations/telnyx/tools',
} as const

describe('buildAssistantPayload', () => {
	const payload = buildAssistantPayload(input) as BuiltPayload

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
		expect(SYSTEM_PROMPT).toContain('Tilbyd aldrig at sende en mail')
		expect(SYSTEM_PROMPT).toContain('lov intet udgående')
		expect(SYSTEM_PROMPT).toContain('framelde dig')
		expect(SYSTEM_PROMPT).not.toContain('send_followup_sms')
		expect(TOOL_DECLARATIONS).toHaveLength(5)
	})
})

describe('buildAssistantPayload against the live assistant snapshot', () => {
	const payload = buildAssistantPayload(input) as BuiltPayload

	it('matches the live name, model and Danish prompt', () => {
		expect(payload.name).toBe(live.name)
		expect(payload.model).toBe(live.model)
		expect(payload.instructions).toBe(live.instructions)
	})

	it('speaks the live opener, then a Conversation node that appends to the instructions', () => {
		const [opener, conversation] = payload.conversation_flow.nodes
		expect(opener.type).toBe('speak')
		expect(opener.message).toBe(live.opener)
		expect(conversation.type).toBe('prompt')
		expect(conversation.name).toBe(live.conversationNode.name)
		expect(conversation.instructions_mode).toBe(live.conversationNode.instructionsMode)
		expect(conversation.instructions).toBe(live.conversationNode.instructions)
		expect(payload.conversation_flow.edges).toHaveLength(1)
	})

	it('declares the live tools with description, parameters, header, timeout and preset', () => {
		expect(payload.tools).toHaveLength(live.tools.length)
		live.tools.forEach((expected, i) => {
			const tool = payload.tools[i].webhook
			expect(tool.name).toBe(expected.name)
			expect(tool.description).toBe(expected.description)
			expect(tool.method).toBe('POST')
			expect(tool.url).toBe(`${input.toolsBaseUrl}/${expected.name}`)
			expect(Object.keys(tool.body_parameters.properties)).toEqual(expected.properties)
			expect(tool.body_parameters.required).toEqual(expected.required)
			expect(tool.headers).toEqual([{ name: 'Authorization', value: 'Bearer test-secret' }])
			expect(tool.timeout_ms).toBe(live.toolTimeoutMs)
			expect(tool.async).toBe(false)
			expect(tool.preset_body_fields).toEqual(live.presetBodyFields)
		})
	})

	it('uses no telnyx_ variable anywhere, because Telnyx rejects those names', () => {
		expect(JSON.stringify(payload)).not.toMatch(/\{\{\s*telnyx_/)
	})

	it('names the assistant once: opener and prompt share the spoken first name', () => {
		expect(ASSISTANT_FIRST_NAME).toBe('Rune')
		expect(DISCLOSURE_TEMPLATES.da).toContain(`jeg hedder ${ASSISTANT_FIRST_NAME},`)
		expect(SYSTEM_PROMPT).toContain(`Du hedder ${ASSISTANT_FIRST_NAME}.`)
	})

	it('accepts the live AI-agent opener as a disclosure', () => {
		expect(DISCLOSURE_PATTERNS.some((re) => re.test(live.opener))).toBe(true)
	})
})

describe('call id dynamic variable', () => {
	const payload = buildAssistantPayload(input) as {
		tools: Array<{ webhook: { name: string; preset_body_fields: Record<string, string> } }>
	}

	it('every tool presets call_control_id from the system variable of the same name', () => {
		expect(payload.tools).toHaveLength(5)
		for (const tool of payload.tools) {
			expect(tool.webhook.preset_body_fields.call_control_id, tool.webhook.name).toBe(
				'{{call_control_id}}',
			)
		}
	})

	it('no dynamic variable in the payload starts with telnyx_ (Telnyx reserves that prefix)', () => {
		const used = [...JSON.stringify(payload).matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1])
		expect(used).toContain('call_control_id')
		expect(used.filter((name) => name?.startsWith('telnyx_'))).toEqual([])
		const { dynamic_variables } = payload as { dynamic_variables?: object }
		const declared = Object.keys(dynamic_variables ?? {})
		expect(declared.filter((name) => name.startsWith('telnyx_'))).toEqual([])
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

	it('keeps the tool secret out of the hash: rotating it keeps the version, dropping the header changes it', () => {
		const a = buildAssistantPayload(input)
		const rotated = buildAssistantPayload({ ...input, toolWebhookSecret: 'another-secret' })
		expect(assistantContentHash(rotated)).toBe(assistantContentHash(a))
		const noHeader = {
			...a,
			tools: (a.tools as Array<{ webhook: Record<string, unknown> }>).map((t) => ({
				...t,
				webhook: { ...t.webhook, headers: [] },
			})),
		}
		expect(assistantContentHash(noHeader)).not.toBe(assistantContentHash(a))
	})

	it('ignores the description field, where the hash itself is stored', () => {
		const a = buildAssistantPayload(input)
		expect(assistantContentHash({ ...a, description: 'whatever' })).toBe(assistantContentHash(a))
	})
})

describe('currentScriptVersion', () => {
	it('is the hash of the payload for the public url, with no secret needed', () => {
		const version = currentScriptVersion({ MASKIN_PUBLIC_URL: 'https://maskin.test/' })
		expect(version).toBe(assistantContentHash(buildAssistantPayload(input)))
	})

	it('throws when MASKIN_PUBLIC_URL is unset instead of hashing relative urls', () => {
		expect(() => currentScriptVersion({})).toThrow('MASKIN_PUBLIC_URL')
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

describe('opener variables', () => {
	it('declares no dynamic variable and names none in any opener, like the live assistant', () => {
		const payload = buildAssistantPayload(input) as { dynamic_variables?: object }
		expect(payload.dynamic_variables).toBeUndefined()
		for (const text of Object.values(DISCLOSURE_TEMPLATES)) {
			expect(text.match(/\{\{[^}]+\}\}/g)).toBeNull()
		}
	})
})
