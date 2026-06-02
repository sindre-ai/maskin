import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/posthog/config'

describe('PostHog provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('posthog')
		expect(config.displayName).toBe('PostHog')
	})

	it('uses api_key auth type with POSTHOG_PERSONAL_API_KEY env var', () => {
		expect(config.auth.type).toBe('api_key')
		if (config.auth.type === 'api_key') {
			expect(config.auth.config.envKeyName).toBe('POSTHOG_PERSONAL_API_KEY')
			expect(config.auth.config.headerName).toBe('Authorization')
			expect(config.auth.config.headerPrefix).toBe('Bearer ')
		}
	})

	it('has no webhook config — data is pulled by the MCP, not pushed', () => {
		expect(config.webhook).toBeUndefined()
	})

	it('has no event definitions — no inbound events to normalize', () => {
		expect(config.events).toBeUndefined()
	})

	it('declares autoInject so session-manager wires the MCP for every workspace with an active integration', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.autoInject).toBe(true)
		expect(config.mcp?.envKey).toBe('POSTHOG_TOKEN')
	})

	it('declares an HTTP server spec matching the frontend INTEGRATION_MCP_PRESETS entry', () => {
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.posthog.com/mcp',
			headers: { Authorization: 'Bearer ${POSTHOG_TOKEN}' },
		})
	})
})
