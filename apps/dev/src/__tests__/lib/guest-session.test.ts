import { describe, expect, it } from 'vitest'
import {
	buildGuestCookieHeader,
	generateGuestSessionId,
	parseGuestCookie,
	signGuestSessionId,
	verifyGuestCookieValue,
} from '../../lib/guest-session'

const SECRET = 'a'.repeat(48)

describe('guest-session', () => {
	it('round-trips a generated id through sign/verify', () => {
		const id = generateGuestSessionId()
		const signed = signGuestSessionId(id, SECRET)
		expect(verifyGuestCookieValue(signed, SECRET)).toBe(id)
	})

	it('rejects a tampered signature', () => {
		const id = generateGuestSessionId()
		const signed = signGuestSessionId(id, SECRET)
		const tampered = `${signed.slice(0, -1)}X`
		expect(verifyGuestCookieValue(tampered, SECRET)).toBeNull()
	})

	it('rejects a value signed with a different secret', () => {
		const id = generateGuestSessionId()
		const signed = signGuestSessionId(id, SECRET)
		expect(verifyGuestCookieValue(signed, 'b'.repeat(48))).toBeNull()
	})

	it('rejects bad id format', () => {
		expect(verifyGuestCookieValue('not_hex_chars!.sig', SECRET)).toBeNull()
	})

	it('parses the maskin_guest cookie out of a multi-cookie header', () => {
		const id = generateGuestSessionId()
		const signed = signGuestSessionId(id, SECRET)
		const header = `other=value; maskin_guest=${signed}; foo=bar`
		expect(parseGuestCookie(header)).toBe(signed)
	})

	it('returns null when the cookie is absent', () => {
		expect(parseGuestCookie('other=value; foo=bar')).toBeNull()
		expect(parseGuestCookie(undefined)).toBeNull()
	})

	it('builds an HttpOnly cookie header with Secure only in production', () => {
		const insecure = buildGuestCookieHeader('value', { secure: false })
		expect(insecure).toContain('HttpOnly')
		expect(insecure).not.toContain('Secure')

		const secure = buildGuestCookieHeader('value', { secure: true })
		expect(secure).toContain('Secure')
		expect(secure).toContain('HttpOnly')
		expect(secure).toContain('SameSite=Lax')
	})
})
