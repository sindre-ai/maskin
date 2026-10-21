import { describe, expect, it } from 'vitest'
import { buildLinkedinAutosendIdempotencyKey } from '../../lib/linkedin-autosend'

describe('buildLinkedinAutosendIdempotencyKey', () => {
	// Task acceptance criterion 5: `{contact_id}:{draft_id}` is what the loop
	// passes on the on-flag path. This helper is the single source of truth
	// for that format so Task 3's `linkedin__send_message` handler and the
	// loop step can't drift.
	it('formats the key as `{contact_id}:{draft_id}` per parent bet spec §5', () => {
		expect(
			buildLinkedinAutosendIdempotencyKey({ contactId: 'contact-42', draftId: 'draft-7' }),
		).toBe('contact-42:draft-7')
	})

	it('trims surrounding whitespace on both ids', () => {
		expect(
			buildLinkedinAutosendIdempotencyKey({ contactId: '  contact-42\n', draftId: '\tdraft-7 ' }),
		).toBe('contact-42:draft-7')
	})

	it('throws when contactId is empty or blank', () => {
		expect(() => buildLinkedinAutosendIdempotencyKey({ contactId: '', draftId: 'd' })).toThrow(
			/contactId is required/,
		)
		expect(() => buildLinkedinAutosendIdempotencyKey({ contactId: '   ', draftId: 'd' })).toThrow(
			/contactId is required/,
		)
	})

	it('throws when draftId is empty or blank', () => {
		expect(() => buildLinkedinAutosendIdempotencyKey({ contactId: 'c', draftId: '' })).toThrow(
			/draftId is required/,
		)
		expect(() => buildLinkedinAutosendIdempotencyKey({ contactId: 'c', draftId: '   ' })).toThrow(
			/draftId is required/,
		)
	})

	it('preserves ids that already contain a colon (colons in ids are opaque to this helper)', () => {
		expect(
			buildLinkedinAutosendIdempotencyKey({
				contactId: 'urn:li:person:AbC123',
				draftId: 'draft-uuid-abcdef',
			}),
		).toBe('urn:li:person:AbC123:draft-uuid-abcdef')
	})
})
