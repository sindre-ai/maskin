import { describe, expect, it } from 'vitest'
import {
	formatKeychainRequestAsMarkdown,
	messageMetadataSchema,
	sessionKeychainCardSchema,
	stripServerOwnedMetadata,
} from '../schemas/conversations'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

describe('stripServerOwnedMetadata', () => {
	it('removes integration_connect so a client cannot forge a Connect card', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('still removes the markers it already owned', () => {
		const stripped = stripServerOwnedMetadata({
			source: 'final_output',
			question: { session_id: SESSION_ID, questions: [] },
			question_answer: { question_message_id: 1, answers: [] },
		})

		// question_answer is client-supplied by design, so it must survive.
		expect(stripped).toEqual({ question_answer: { question_message_id: 1, answers: [] } })
	})
})

describe('messageMetadataSchema integration_connect', () => {
	it('accepts a session id and a provider name', () => {
		const parsed = messageMetadataSchema.safeParse({
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(parsed.success).toBe(true)
	})

	it('rejects a card with no provider or a non-uuid session', () => {
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: SESSION_ID, provider: '' },
			}).success,
		).toBe(false)
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: 'nope', provider: 'linear' },
			}).success,
		).toBe(false)
	})
})

describe('keychain_request', () => {
	it('is removed from client metadata so a client cannot forge a Keychain card', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			keychain_request: { session_id: SESSION_ID, kind: 'login' },
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('accepts a login or api_key request, with an optional name and hint', () => {
		for (const kind of ['login', 'api_key'] as const) {
			const parsed = messageMetadataSchema.safeParse({
				keychain_request: {
					session_id: SESSION_ID,
					kind,
					suggested_name: 'e-conomic',
					hint: 'To read invoices.',
				},
			})
			expect(parsed.success).toBe(true)
		}
	})

	it('rejects an unknown kind, a bad session id and an over-long name', () => {
		const bad = [
			{ session_id: SESSION_ID, kind: 'password' },
			{ session_id: 'nope', kind: 'login' },
			{ session_id: SESSION_ID, kind: 'login', suggested_name: 'x'.repeat(81) },
		]
		for (const keychain_request of bad) {
			expect(messageMetadataSchema.safeParse({ keychain_request }).success).toBe(false)
		}
	})
})

describe('sessionKeychainCardSchema', () => {
	it('needs a kind and trims the optional fields', () => {
		expect(sessionKeychainCardSchema.safeParse({}).success).toBe(false)
		expect(
			sessionKeychainCardSchema.parse({ kind: 'api_key', suggested_name: '  Stripe  ' }),
		).toEqual({ kind: 'api_key', suggested_name: 'Stripe' })
	})
})

describe('formatKeychainRequestAsMarkdown', () => {
	it('says what is needed and where it goes, for readers that are not the chat UI', () => {
		const text = formatKeychainRequestAsMarkdown('login', 'e-conomic', 'To read invoices.')
		expect(text).toContain('login')
		expect(text).toContain('**e-conomic**')
		expect(text).toContain('To read invoices.')
		expect(text).toContain('Settings → Keychain')
	})

	it('names an API key when that is the kind, and copes with no name or hint', () => {
		expect(formatKeychainRequestAsMarkdown('api_key')).toContain('an API key')
	})
})
