import { describe, expect, it } from 'vitest'
import { readUnipileEnvelope } from '../../../../../lib/integrations/providers/linkedin-unipile/envelope'

describe('readUnipileEnvelope', () => {
	it('reads type, account id, envelope id and resource from the flat envelope', () => {
		const envelope = readUnipileEnvelope({
			id: 'evt_1',
			created_at: '2026-10-04T10:00:00.000Z',
			account_id: 'acc_1',
			type: 'message.new',
			payload: { id: 'msg_1' },
		})
		expect(envelope).toEqual({
			type: 'message.new',
			accountId: 'acc_1',
			envelopeId: 'evt_1',
			resource: { id: 'msg_1' },
		})
	})

	it('falls back to body.event when body.type is absent', () => {
		expect(readUnipileEnvelope({ event: 'account.reconnect', account_id: 'a' }).type).toBe(
			'account.reconnect',
		)
	})

	it('prefers body.type over body.event', () => {
		expect(readUnipileEnvelope({ type: 'message.new', event: 'other' }).type).toBe('message.new')
	})

	it('reads the account id from body.account_id only, never from the resource', () => {
		const envelope = readUnipileEnvelope({
			type: 'message.new',
			payload: { account_id: 'nested', account: { id: 'nested2' } },
		})
		expect(envelope.accountId).toBeNull()
	})

	it('returns nulls for anything that is not an object or has empty fields', () => {
		const empty = { type: null, accountId: null, envelopeId: null, resource: null }
		expect(readUnipileEnvelope(null)).toEqual(empty)
		expect(readUnipileEnvelope('x')).toEqual(empty)
		expect(readUnipileEnvelope([])).toEqual(empty)
		expect(readUnipileEnvelope({ type: '', account_id: '', id: '', payload: [] })).toEqual(empty)
	})
})
