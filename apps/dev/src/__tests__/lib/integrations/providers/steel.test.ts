import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/steel/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Steel integration provider', () => {
	it('appears in listProviders()', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('steel')
	})

	it('can be retrieved by name', () => {
		const provider = getProvider('steel')
		expect(provider.config.name).toBe('steel')
		expect(provider.config.displayName).toBe('Steel')
	})

	it('uses api_key auth type', () => {
		expect(config.auth.type).toBe('api_key')
	})

	it('has correct api_key config', () => {
		if (config.auth.type !== 'api_key') throw new Error('Expected api_key auth')
		expect(config.auth.config.headerName).toBe('X-Steel-Api-Key')
		expect(config.auth.config.envKeyName).toBe('STEEL_API_KEY')
	})

	it('has mcp config', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.command).toBe('npx')
		expect(config.mcp?.args).toContain('@steel-dev/steel-mcp-server')
		expect(config.mcp?.envKey).toBe('STEEL_API_KEY')
	})

	it('has no webhook or events config', () => {
		expect(config.webhook).toBeUndefined()
		expect(config.events).toBeUndefined()
	})
})
