import { describe, expect, it } from 'vitest'
import { getProvider, listProviders } from '../../../lib/integrations/registry'

describe('registry', () => {
	describe('getProvider', () => {
		it('returns GitHub provider', () => {
			const provider = getProvider('github')
			expect(provider.config.name).toBe('github')
			expect(provider.config.displayName).toBe('GitHub')
			expect(provider.config.auth.type).toBe('oauth2_custom')
			expect(provider.customAuth).toBeDefined()
			expect(provider.customNormalizer).toBeDefined()
		})

		it('throws for unknown provider', () => {
			expect(() => getProvider('nonexistent')).toThrow('Unknown integration provider: nonexistent')
		})
	})

	describe('listProviders', () => {
		it('returns all registered providers', () => {
			const providers = listProviders()
			expect(providers.length).toBeGreaterThanOrEqual(1)
			const names = providers.map((p) => p.config.name)
			expect(names).toContain('github')
		})
	})
})
