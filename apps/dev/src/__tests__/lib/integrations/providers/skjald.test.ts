import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/skjald/config'

describe('Skjald provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('skjald')
		expect(config.displayName).toBe('Skjald')
	})

	it('uses manual auth — Maskin invents the credential handshake itself', () => {
		expect(config.auth.type).toBe('manual')
	})

	it('has no webhook config — deliveries go through the dedicated /skjald/:token route', () => {
		expect(config.webhook).toBeUndefined()
	})

	it('declares a meeting event definition for created/updated', () => {
		expect(config.events?.definitions).toEqual([
			{ entityType: 'meeting', actions: ['created', 'updated'], label: 'Meeting' },
		])
	})

	it('has no mcp config', () => {
		expect(config.mcp).toBeUndefined()
	})
})
