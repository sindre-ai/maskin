import { describe, expect, it } from 'vitest'
import { FLAGS, parseFeatureFlagConfig } from '../../lib/feature-flags'
import {
	buildLinkedinAutosendIdempotencyKey,
	isSalesRepLinkedinAutosendEnabled,
} from '../../lib/linkedin-autosend'

const DRIVER_ACTOR = '9f1e7a53-2b8c-4d0e-8a3f-6c0b71d5e924'
const OTHER_ACTOR = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

function config(env: Record<string, string | undefined>) {
	return parseFeatureFlagConfig(env as NodeJS.ProcessEnv)
}

describe('isSalesRepLinkedinAutosendEnabled', () => {
	// Task acceptance criterion 1: the flag exists in the registry and defaults
	// OFF when no env is set. Any actor sees false — the loop step must fall
	// through to today's "draft posted for human review only" path.
	it('is false when no FF_ env vars are set (default OFF)', () => {
		expect(isSalesRepLinkedinAutosendEnabled(DRIVER_ACTOR, config({}))).toBe(false)
	})

	it('is false for an actor listed as tester when the flag id is not in FF_TESTER_FEATURES', () => {
		expect(
			isSalesRepLinkedinAutosendEnabled(
				DRIVER_ACTOR,
				config({ FF_TESTER_ACTOR_IDS: DRIVER_ACTOR }),
			),
		).toBe(false)
	})

	it('is false for a non-tester actor when the flag id IS in FF_TESTER_FEATURES', () => {
		expect(
			isSalesRepLinkedinAutosendEnabled(
				OTHER_ACTOR,
				config({
					FF_TESTER_FEATURES: FLAGS.SALES_REP_LINKEDIN_AUTOSEND,
					FF_TESTER_ACTOR_IDS: DRIVER_ACTOR,
				}),
			),
		).toBe(false)
	})

	// Task acceptance criterion 3 (partial — the flag-gate half): when the flag
	// is on for a workspace's driver-actor AND the credential is connected,
	// the loop can invoke linkedin__send_message end-to-end. The credential
	// half + the actual invocation come from Task 3's server work; this test
	// verifies the flag gate itself.
	it('is true for the driver-actor when the flag id is in FF_TESTER_FEATURES AND actor is a tester', () => {
		expect(
			isSalesRepLinkedinAutosendEnabled(
				DRIVER_ACTOR,
				config({
					FF_TESTER_FEATURES: FLAGS.SALES_REP_LINKEDIN_AUTOSEND,
					FF_TESTER_ACTOR_IDS: DRIVER_ACTOR,
				}),
			),
		).toBe(true)
	})
})

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
