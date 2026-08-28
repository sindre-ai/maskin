import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	mintToolBrokerSessionToken,
	verifyToolBrokerSessionToken,
} from '../../lib/tool-broker/session-token'

const SECRET = 'a'.repeat(48)
const CLAIMS = { sessionId: 'sess-1', workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	process.env.TOOL_BROKER_SESSION_SECRET = SECRET
})

afterEach(() => {
	vi.useRealTimers()
	delete process.env.TOOL_BROKER_SESSION_SECRET
})

describe('tool broker session token', () => {
	it('round-trips the claims it was minted with', () => {
		const claims = verifyToolBrokerSessionToken(mintToolBrokerSessionToken(CLAIMS))
		expect(claims).toMatchObject(CLAIMS)
	})

	it('rejects a token whose payload was edited', () => {
		// The whole point: a container must not be able to repoint itself at
		// another workspace by rewriting the payload.
		const token = mintToolBrokerSessionToken(CLAIMS)
		const [encoded, signature] = token.split('.')
		const payload = Buffer.from(encoded ?? '', 'base64url').toString()
		const swapped = Buffer.from(payload.replace('ws-1', 'ws-2')).toString('base64url')

		expect(verifyToolBrokerSessionToken(`${swapped}.${signature}`)).toBeNull()
	})

	it('rejects a token signed with a different secret', () => {
		const token = mintToolBrokerSessionToken(CLAIMS)
		process.env.TOOL_BROKER_SESSION_SECRET = 'b'.repeat(48)
		expect(verifyToolBrokerSessionToken(token)).toBeNull()
	})

	it('rejects an expired token', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		const token = mintToolBrokerSessionToken(CLAIMS, 60)

		vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
		expect(verifyToolBrokerSessionToken(token)).toBeNull()
	})

	it.each([['' /* empty */], ['garbage'], ['only-one-part'], ['a.b.c.d']])(
		'rejects the malformed token %j',
		(token) => {
			expect(verifyToolBrokerSessionToken(token)).toBeNull()
		},
	)

	it('refuses to mint without a sufficiently long secret', () => {
		process.env.TOOL_BROKER_SESSION_SECRET = 'too-short'
		// Failing loudly at mint time beats minting a token anyone can forge.
		expect(() => mintToolBrokerSessionToken(CLAIMS)).toThrow(/at least 32 characters/)
	})
})
