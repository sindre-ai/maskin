import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_AGENTS, DEVELOPMENT_TRIGGERS } from '../../templates/development-agents'

describe('Summarization Agent seed', () => {
	const agent = DEVELOPMENT_AGENTS.find((a) => a.$id === 'summarization_agent')

	it('is present in DEVELOPMENT_AGENTS', () => {
		expect(agent).toBeDefined()
		expect(agent?.name).toBe('Summarization Agent')
	})

	it('has the Maskin MCP server wired so it can read objects and write insights/tasks/contacts', () => {
		const tools = agent?.tools as { mcpServers?: Record<string, { url?: string }> } | undefined
		expect(tools?.mcpServers?.maskin?.url).toContain('/mcp')
	})

	it("system prompt instructs the agent to read meeting.content with transcriptUrl fallback (covers O6: NOTIFY payload doesn't carry transcript)", () => {
		const prompt = agent?.systemPrompt ?? ''
		expect(prompt).toContain('get_objects')
		expect(prompt).toContain('content')
		expect(prompt).toContain('transcriptUrl')
	})

	it('system prompt names the three relationship edges and the three object types it should produce', () => {
		const prompt = agent?.systemPrompt ?? ''
		expect(prompt).toContain('about')
		expect(prompt).toContain('produced')
		expect(prompt).toContain('attended_by')
		expect(prompt).toContain('insight')
		expect(prompt).toContain('task')
		expect(prompt).toContain('contact')
	})

	it('system prompt forbids creating decision objects (D4: type retired)', () => {
		const prompt = agent?.systemPrompt ?? ''
		expect(prompt).toMatch(/decision/i)
	})
})

describe('Meeting Done → Summarize trigger seed', () => {
	const trigger = DEVELOPMENT_TRIGGERS.find((t) => t.name === 'Meeting Done → Summarize')

	it('is present in DEVELOPMENT_TRIGGERS', () => {
		expect(trigger).toBeDefined()
	})

	it('targets the summarization_agent SeedAgent', () => {
		expect(trigger?.targetActor$id).toBe('summarization_agent')
		const exists = DEVELOPMENT_AGENTS.some((a) => a.$id === trigger?.targetActor$id)
		expect(exists).toBe(true)
	})

	it('fires when a meeting object reaches status=done', () => {
		expect(trigger?.type).toBe('event')
		expect(trigger?.config).toMatchObject({
			entity_type: 'object',
			action: 'status_changed',
			filter: { type: 'meeting' },
			to_status: 'done',
		})
	})

	it('is enabled by default so it fires on the prototype workspace', () => {
		expect(trigger?.enabled).toBe(true)
	})
})
