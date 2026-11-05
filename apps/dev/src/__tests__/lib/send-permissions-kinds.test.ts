import { SEND_PERMISSION_KINDS, STARTING_SEND_MODES } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { listDeliverableKinds } from '../../lib/object-preview'

// A draft kind an integration can send needs a send setting. A kind missing from the list still
// asks first (the safe side), but then no one can switch it from the settings screen.
describe('send permission kinds', () => {
	it('covers every deliverable kind that an integration declares', () => {
		const declared = listDeliverableKinds().map((k) => k.deliverable.kind)
		expect(declared.length).toBeGreaterThan(0)
		for (const kind of declared) expect(SEND_PERMISSION_KINDS).toContain(kind)
	})

	it('has a starting mode for every kind', () => {
		for (const kind of SEND_PERMISSION_KINDS) expect(STARTING_SEND_MODES[kind]).toBeDefined()
	})
})
