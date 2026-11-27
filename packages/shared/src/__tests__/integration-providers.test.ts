import { describe, expect, it } from 'vitest'
import { MULTI_INSTALL_PROVIDERS } from '../integration-providers'

describe('MULTI_INSTALL_PROVIDERS', () => {
	it('allows several accounts for Google Calendar and Linear, as for Gmail', () => {
		for (const provider of ['gmail', 'google-calendar', 'linear']) {
			expect(MULTI_INSTALL_PROVIDERS.has(provider)).toBe(true)
		}
	})

	it('keeps providers that answer from one connection single-install', () => {
		for (const provider of [
			'slack',
			'google-drive',
			'google-meet',
			'google-search-console',
			'youtube',
			'posthog',
		]) {
			expect(MULTI_INSTALL_PROVIDERS.has(provider)).toBe(false)
		}
	})
})
