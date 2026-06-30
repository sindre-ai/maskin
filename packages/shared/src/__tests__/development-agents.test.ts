import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_AGENTS } from '../templates/development-agents'

function getMcpServers(tools: unknown): Record<string, unknown> {
	const t = tools as { mcpServers?: Record<string, unknown> } | undefined
	return t?.mcpServers ?? {}
}

describe('DEVELOPMENT_AGENTS context7 wiring', () => {
	it('registers context7 on the Senior Developer with the canonical HTTP tuple', () => {
		const dev = DEVELOPMENT_AGENTS.find((a) => a.$id === 'senior_developer')
		expect(dev).toBeDefined()

		const servers = getMcpServers(dev?.tools)
		expect(servers.context7).toEqual({
			url: 'https://mcp.context7.com/mcp',
			type: 'http',
		})
	})

	it('preserves the existing github + maskin entries on the Senior Developer', () => {
		const dev = DEVELOPMENT_AGENTS.find((a) => a.$id === 'senior_developer')
		const servers = getMcpServers(dev?.tools)
		expect(servers.github).toBeDefined()
		expect(servers.maskin).toBeDefined()
	})

	it('does NOT register context7 on any other DEVELOPMENT_AGENTS entry', () => {
		const leaked = DEVELOPMENT_AGENTS.filter(
			(a) => a.$id !== 'senior_developer' && 'context7' in getMcpServers(a.tools),
		).map((a) => a.$id)
		expect(leaked).toEqual([])
	})
})
