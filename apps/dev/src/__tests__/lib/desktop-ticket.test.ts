import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	DESKTOP_TICKET_TTL_MS,
	consumeDesktopTicket,
	signDesktopTicket,
} from '../../lib/desktop-ticket'

const CLAIMS = {
	workspaceId: '11111111-1111-4111-8111-111111111111',
	actorId: '22222222-2222-4222-8222-222222222222',
}

describe('desktop ticket', () => {
	let original: string | undefined
	beforeEach(() => {
		original = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
	})
	afterEach(() => {
		if (original === undefined) process.env.INTEGRATION_ENCRYPTION_KEY = undefined
		else process.env.INTEGRATION_ENCRYPTION_KEY = original
	})

	it('round-trips the claims', () => {
		const now = 1_000_000
		expect(consumeDesktopTicket(signDesktopTicket(CLAIMS, now), now)).toEqual(CLAIMS)
	})

	it('is single-use', () => {
		const now = 2_000_000
		const ticket = signDesktopTicket(CLAIMS, now)
		expect(consumeDesktopTicket(ticket, now)).not.toBeNull()
		expect(consumeDesktopTicket(ticket, now)).toBeNull()
	})

	it('expires after the TTL', () => {
		const now = 3_000_000
		const ticket = signDesktopTicket(CLAIMS, now)
		expect(consumeDesktopTicket(ticket, now + DESKTOP_TICKET_TTL_MS)).toBeNull()
	})

	it('rejects a tampered payload', () => {
		const now = 4_000_000
		const [body, sig] = signDesktopTicket(CLAIMS, now).split('.') as [string, string]
		const forged = JSON.parse(Buffer.from(body, 'base64url').toString())
		forged.w = '33333333-3333-4333-8333-333333333333'
		const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url')
		expect(consumeDesktopTicket(`${forgedBody}.${sig}`, now)).toBeNull()
	})

	it('rejects a ticket signed with a different key', () => {
		const now = 5_000_000
		const ticket = signDesktopTicket(CLAIMS, now)
		process.env.INTEGRATION_ENCRYPTION_KEY = 'cd'.repeat(32)
		expect(consumeDesktopTicket(ticket, now)).toBeNull()
	})

	it.each(['', 'nodot', '.sig', 'body.', 'a.b.c'])('rejects malformed %j', (bad) => {
		expect(consumeDesktopTicket(bad)).toBeNull()
	})
})
