import { describe, expect, it } from 'vitest'
import { KNOWLEDGE_NUDGES } from '../prompts'
import { DEVELOPMENT_AGENTS } from '../templates/development-agents'
import { GROWTH_AGENTS } from '../templates/growth-agents'
import { OUTBOUND_SALES_AGENTS } from '../templates/outbound-sales-agents'

describe('KNOWLEDGE_NUDGES', () => {
	it('mentions the knowledge read/write tools', () => {
		expect(KNOWLEDGE_NUDGES).toContain('search_objects')
		expect(KNOWLEDGE_NUDGES).toContain('create_objects')
		expect(KNOWLEDGE_NUDGES).toContain("type:'knowledge'")
	})

	it('instructs agents to prefer update over duplicate creation', () => {
		expect(KNOWLEDGE_NUDGES).toContain('update_objects')
		expect(KNOWLEDGE_NUDGES.toLowerCase()).toMatch(/near-match|near match/)
	})

	it('is NOT baked into template agent prompts — injected at session start only', () => {
		const allTemplates = [...DEVELOPMENT_AGENTS, ...GROWTH_AGENTS, ...OUTBOUND_SALES_AGENTS]
		expect(allTemplates.length).toBeGreaterThan(0)
		for (const agent of allTemplates) {
			expect(
				agent.systemPrompt.includes(KNOWLEDGE_NUDGES),
				`${agent.name} should not carry KNOWLEDGE_NUDGES — the session manager appends it conditionally`,
			).toBe(false)
		}
	})
})
