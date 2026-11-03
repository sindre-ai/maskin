import { describe, expect, it } from 'vitest'
import { messageMetadataSchema, stripServerOwnedMetadata } from '../schemas/conversations'

describe('message delivery marker', () => {
	it('accepts any kind string and keeps the optional fields', () => {
		const parsed = messageMetadataSchema.parse({
			delivery: { kind: 'proactive', reason: 'capability_note', dedupe_key: 'k', version: 1 },
		})
		expect(parsed.delivery).toEqual({
			kind: 'proactive',
			reason: 'capability_note',
			dedupe_key: 'k',
			version: 1,
		})
		expect(messageMetadataSchema.safeParse({ delivery: { kind: 'agent_intro' } }).success).toBe(
			true,
		)
	})

	it('rejects an empty kind and a kind over 40 characters', () => {
		expect(messageMetadataSchema.safeParse({ delivery: { kind: '' } }).success).toBe(false)
		expect(messageMetadataSchema.safeParse({ delivery: { kind: 'x'.repeat(41) } }).success).toBe(
			false,
		)
	})

	it('is backend-owned: a client cannot post it', () => {
		const stripped = stripServerOwnedMetadata({
			delivery: { kind: 'proactive', reason: 'capability_note', dedupe_key: 'forged' },
			mentions: ['11111111-1111-4111-8111-111111111111'],
		})
		expect(stripped).toEqual({ mentions: ['11111111-1111-4111-8111-111111111111'] })
	})
})
