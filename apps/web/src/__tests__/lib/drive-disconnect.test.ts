import { describe, expect, it } from 'vitest'

import { connectedGoogleProviders, joinServices, remainingProviders } from '@/lib/drive-disconnect'
import { buildIntegrationResponse } from '../factories'

const row = (provider: string, externalId: string, status = 'active') =>
	buildIntegrationResponse({ provider, externalId, status })

describe('joinServices', () => {
	it('joins labels the way the copy reads', () => {
		expect(joinServices([])).toBe('')
		expect(joinServices(['gmail'])).toBe('Gmail')
		expect(joinServices(['gmail', 'google-meet'])).toBe('Gmail and Meet')
		expect(joinServices(['gmail', 'google-calendar', 'google-meet'])).toBe(
			'Gmail, Calendar and Meet',
		)
	})
})

describe('connectedGoogleProviders', () => {
	it('lists the human live Google-family rows in display order, case-insensitively', () => {
		const rows = [
			row('google-drive', 'Kai@Acme.test'),
			row('gmail', 'kai@acme.test'),
			row('google-meet', 'kai@acme.test', 'revoked'),
			row('google-calendar', 'priya@acme.test'),
			row('slack', 'kai@acme.test'),
		]
		expect(connectedGoogleProviders(rows, 'kai@acme.test')).toEqual(['gmail', 'google-drive'])
	})
})

describe('remainingProviders', () => {
	const all = ['gmail', 'google-calendar', 'google-meet', 'google-drive']
	it('drive keeps the other three, drive-meet keeps two, google keeps none', () => {
		expect(remainingProviders(all, 'drive')).toEqual(['gmail', 'google-calendar', 'google-meet'])
		expect(remainingProviders(all, 'drive-meet')).toEqual(['gmail', 'google-calendar'])
		expect(remainingProviders(all, 'google')).toEqual([])
	})
})
