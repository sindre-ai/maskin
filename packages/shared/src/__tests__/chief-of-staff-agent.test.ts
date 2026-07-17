import { describe, expect, it } from 'vitest'
import {
	CHIEF_OF_STAFF_DEFAULT,
	CHIEF_OF_STAFF_SYSTEM_PROMPT,
} from '../templates/chief-of-staff-agent'

describe('Chief of Staff default template', () => {
	it('states the boundary rule verbatim in the system prompt', () => {
		// The parent bet requires that the guardrail is enforced from the prompt,
		// not only from downstream detection — this exact sentence is the guardrail
		// contract other tasks (T4 thinness detection) key off.
		expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain(
			'do not produce domain output; summon a specialist for any domain ask',
		)
	})

	it('is marked as a system agent', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.isSystem).toBe(true)
		expect(CHIEF_OF_STAFF_DEFAULT.type).toBe('agent')
		expect(CHIEF_OF_STAFF_DEFAULT.name).toBe('Chief of Staff')
	})

	it('exposes the maskin MCP server so it can spawn specialist sessions', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.tools.mcpServers.maskin).toBeDefined()
	})
})
