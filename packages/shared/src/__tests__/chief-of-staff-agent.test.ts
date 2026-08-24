import { describe, expect, it } from 'vitest'
import {
	CHIEF_OF_STAFF_DEFAULT,
	CHIEF_OF_STAFF_SYSTEM_PROMPT,
} from '../templates/default-workspace-agents'

describe('Chief of Staff default template', () => {
	it('ships a non-empty system prompt and description', () => {
		expect(CHIEF_OF_STAFF_SYSTEM_PROMPT.length).toBeGreaterThan(0)
		expect(CHIEF_OF_STAFF_DEFAULT.description.length).toBeGreaterThan(0)
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
