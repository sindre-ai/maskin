import { describe, expect, it } from 'vitest'
import { config } from '../../../../../lib/integrations/providers/linkedin-unipile/config'

/**
 * The MCP registration is the discovery contract every non-browser client
 * reads to know that a provider exposes tools. Absent, `list_integration_providers`
 * emits the provider with no `mcp` field and an agent correctly infers "no
 * MCP server for this provider" — the R11 fan-out MCP was invisible to
 * every workspace agent for exactly that reason before this block was
 * added, even with LinkedIn connected. Pin the exact shape so the same
 * omission cannot regress.
 */
describe('linkedin-unipile provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('linkedin-unipile')
		expect(config.displayName).toBe('LinkedIn')
	})

	it('auto-injects the Maskin-hosted LinkedIn MCP HTTP server', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.envKey).toBe('LINKEDIN_UNIPILE_TOKEN')
		expect(config.mcp?.autoInject).toBe(true)
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		})
	})
})
