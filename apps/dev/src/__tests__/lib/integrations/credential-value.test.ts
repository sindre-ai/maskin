import { describe, expect, it } from 'vitest'
import {
	CREDENTIAL_VALUE_MAX_LENGTH,
	CredentialValueError,
	assertValidCredentialValue,
	checkCredentialValue,
} from '../../../lib/integrations/credential-value'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const TOKEN = `fake-token-${'0123456789'.repeat(3)}`

describe('checkCredentialValue', () => {
	it('accepts a normal token', () => {
		expect(checkCredentialValue(TOKEN)).toBeNull()
		expect(checkCredentialValue('Bearer-free_token.with~symbols+/=')).toBeNull()
	})

	it('accepts the length limits', () => {
		expect(checkCredentialValue('a')).toBeNull()
		expect(checkCredentialValue('a'.repeat(CREDENTIAL_VALUE_MAX_LENGTH))).toBeNull()
	})

	it.each([
		['an empty value', '', 'length'],
		['1025 characters', 'a'.repeat(CREDENTIAL_VALUE_MAX_LENGTH + 1), 'length'],
		['a trailing newline', `${TOKEN}\n`, 'edge_whitespace'],
		['a trailing carriage return and newline', `${TOKEN}\r\n`, 'edge_whitespace'],
		['a trailing space', `${TOKEN} `, 'edge_whitespace'],
		['a leading space', ` ${TOKEN}`, 'edge_whitespace'],
		['a leading tab', `\t${TOKEN}`, 'edge_whitespace'],
		['a newline inside', 'abc\ndef', 'control_character'],
		['a NUL byte', 'abc\u0000def', 'control_character'],
		['a DEL byte', 'abc\u007fdef', 'control_character'],
		['a non-ASCII letter', 'abcédef', 'non_ascii'],
		['a double quote', 'abc"def', 'double_quote'],
		['a backslash', 'abc\\def', 'backslash'],
	])('rejects %s', (_label, value, problem) => {
		expect(checkCredentialValue(value)).toBe(problem)
	})
})

describe('assertValidCredentialValue', () => {
	it('passes a normal token', () => {
		expect(() => assertValidCredentialValue(TOKEN)).not.toThrow()
	})

	it('names the rule that failed and never repeats the value', () => {
		for (const value of [`${TOKEN}\n`, `${TOKEN}"x`, `${TOKEN}\\x`, 'a'.repeat(1025)]) {
			let error: unknown
			try {
				assertValidCredentialValue(value)
			} catch (err) {
				error = err
			}
			expect(error).toBeInstanceOf(CredentialValueError)
			const e = error as CredentialValueError
			expect(e.status).toBe(400)
			expect(e.message).not.toContain(TOKEN)
			expect(e.message).not.toContain('aaaa')
		}
		expect(() => assertValidCredentialValue('a"b')).toThrow(/double quote/)
		expect(() => assertValidCredentialValue('a\\b')).toThrow(/backslash/)
		expect(() => assertValidCredentialValue('ab\n')).toThrow(/whitespace/)
		expect(() => assertValidCredentialValue('a'.repeat(1025))).toThrow(/1 to 1024/)
	})
})
