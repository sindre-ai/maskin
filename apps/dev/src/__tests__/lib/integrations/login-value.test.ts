import { describe, expect, it } from 'vitest'
import { decodeLogin, encodeLogin } from '../../../lib/integrations/byo-login'
import {
	LOGIN_EMAIL_MAX_LENGTH,
	LOGIN_PASSWORD_MAX_LENGTH,
	LOGIN_USERNAME_MAX_LENGTH,
	LoginValueError,
	assertValidLoginFields,
	checkLoginFields,
} from '../../../lib/integrations/login-value'

describe('checkLoginFields', () => {
	it('accepts the characters an API key may not hold, because a password routinely does', () => {
		expect(checkLoginFields('me@example.test', 'pw"withodd\'chars-æøå 1')).toBeNull()
	})

	it('allows spaces at the edges of a password but not of a username', () => {
		expect(checkLoginFields('me', ' padded ')).toBeNull()
		expect(checkLoginFields(' me', 'pw')).toBe('username_edge_whitespace')
		expect(checkLoginFields('me\n', 'pw')).toBe('username_edge_whitespace')
	})

	it('refuses a line break or other control character in the password', () => {
		expect(checkLoginFields('me', 'abc\ndef')).toBe('password_control_character')
		expect(checkLoginFields('me', 'abc\u0000def')).toBe('password_control_character')
		expect(checkLoginFields('me', 'abc\u007fdef')).toBe('password_control_character')
	})

	it('refuses an empty or over-long username and password', () => {
		expect(checkLoginFields('', 'pw')).toBe('username_length')
		expect(checkLoginFields('a'.repeat(LOGIN_USERNAME_MAX_LENGTH + 1), 'pw')).toBe(
			'username_length',
		)
		expect(checkLoginFields('me', '')).toBe('password_length')
		expect(checkLoginFields('me', 'a'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1))).toBe(
			'password_length',
		)
	})
})

describe('checkLoginFields with an email', () => {
	it('accepts a login with no email, or a well-formed one', () => {
		expect(checkLoginFields('me', 'pw')).toBeNull()
		expect(checkLoginFields('me', 'pw', 'me@example.test')).toBeNull()
	})

	it('holds the email to the username rules', () => {
		expect(checkLoginFields('me', 'pw', '')).toBe('email_length')
		expect(checkLoginFields('me', 'pw', 'a'.repeat(LOGIN_EMAIL_MAX_LENGTH + 1))).toBe(
			'email_length',
		)
		expect(checkLoginFields('me', 'pw', ' me@example.test')).toBe('email_edge_whitespace')
		expect(checkLoginFields('me', 'pw', 'me@exa\u0000mple.test')).toBe('email_control_character')
	})
})

describe('assertValidLoginFields', () => {
	it('throws a 400 whose message names the rule and never the value', () => {
		const password = 'secret\nvalue'
		try {
			assertValidLoginFields('me', password)
			expect.unreachable()
		} catch (err) {
			expect(err).toBeInstanceOf(LoginValueError)
			expect((err as LoginValueError).status).toBe(400)
			expect((err as LoginValueError).message).not.toContain('secret')
		}
	})
})

describe('encodeLogin / decodeLogin', () => {
	it('round-trips every character, quotes and backslashes included', () => {
		const login = { username: 'me@example.test', password: 'pw"withodd\'chars-æøå' }
		expect(decodeLogin(encodeLogin(login))).toEqual(login)
	})

	it('round-trips an email, and a login without one stays without', () => {
		const withEmail = { username: 'me', password: 'pw', email: 'me@example.test' }
		expect(decodeLogin(encodeLogin(withEmail))).toEqual(withEmail)
		expect(encodeLogin({ username: 'me', password: 'pw' })).not.toContain('email')
	})

	it.each([
		['not json'],
		['{"username":"me","password":"pw","email":1}'],
		['null'],
		['"a string"'],
		['{"username":"me"}'],
		['{"username":1,"password":2}'],
	])('decodes %s to null rather than throwing', (value) => {
		expect(decodeLogin(value)).toBeNull()
	})
})
