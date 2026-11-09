import { SEND_PERMISSION_KINDS, STARTING_SEND_MODES } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { listDeliverableKinds } from '../../lib/object-preview'

// Deliverable kinds that are never sent through a send tool, so there is no send to gate.
// manual_message is typed by hand by the agent after a person approves the text.
const KINDS_WITHOUT_A_SEND_TOOL = ['manual_message']

// A draft kind an integration can send needs a send setting. A kind missing from the list still
// asks first (the safe side), but then no one can switch it from the settings screen.
describe('send permission kinds', () => {
	it('covers every deliverable kind that an integration declares', () => {
		const declared = listDeliverableKinds()
			.map((k) => k.deliverable.kind)
			.filter((kind) => !KINDS_WITHOUT_A_SEND_TOOL.includes(kind))
		expect(declared.length).toBeGreaterThan(0)
		for (const kind of declared) expect(SEND_PERMISSION_KINDS).toContain(kind)
	})

	it('has a starting mode for every kind', () => {
		for (const kind of SEND_PERMISSION_KINDS) expect(STARTING_SEND_MODES[kind]).toBeDefined()
	})
})
