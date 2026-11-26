import { describe, expect, it } from 'vitest'
import { createKeychainMasker, redactTokenShapes } from '../log-redaction'

// Fake values only. None of these is, or was ever, a real secret.
const FAKE_KEY = 'fake-key-0123456789-abcdefghij'
const FAKE_PEM = [
	'-----BEGIN PRIVATE KEY-----',
	'FAKEFAKEFAKEfakefakefakeAAAA1111BBBB2222',
	'cccc3333DDDD4444eeee5555FFFF6666gggg7777',
	'short',
	'-----END PRIVATE KEY-----',
].join('\n')
const NAME = 'KEYCHAIN_BYO_APIKEY_TEST'

describe('createKeychainMasker', () => {
	it('masks the raw value and names the credential', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_KEY })
		expect(mask?.(`echo ${FAKE_KEY} done`)).toBe(`echo [REDACTED · ${NAME}] done`)
	})

	it('masks the JSON-escaped form of a multi-line value inside a stream-json line', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_PEM })
		const line = JSON.stringify({ type: 'user', content: FAKE_PEM })
		const out = mask?.(line) ?? ''
		expect(out).toContain(`[REDACTED · ${NAME}]`)
		expect(out).not.toContain('FAKEFAKEFAKE')
		expect(out).not.toContain('BEGIN PRIVATE KEY')
		expect(JSON.parse(out).type).toBe('user')
	})

	it('masks a value that sits in JSON inside a JSON string', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_PEM })
		const inner = JSON.stringify({ body: FAKE_PEM })
		const out = mask?.(JSON.stringify({ result: inner })) ?? ''
		expect(out).not.toContain('FAKEFAKEFAKE')
		expect(out).not.toContain('cccc3333')
	})

	it('masks each long line and each PEM boundary line of a multi-line value printed alone', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_PEM })
		for (const line of FAKE_PEM.split('\n').filter((l) => l !== 'short')) {
			expect(mask?.(line)).toBe(`[REDACTED · ${NAME}]`)
		}
		// A line under 16 characters is ordinary text.
		expect(mask?.('short')).toBe('short')
	})

	it('masks a PEM boundary line even when it is under 16 characters', () => {
		const mask = createKeychainMasker({ [NAME]: '-----BEGIN-----\nsome-long-enough-body-line' })
		expect(mask?.('-----BEGIN-----')).toBe(`[REDACTED · ${NAME}]`)
	})

	it('ignores a value shorter than 8 characters', () => {
		expect(createKeychainMasker({ [NAME]: '1234567' })).toBeNull()
		expect(createKeychainMasker({})).toBeNull()
	})

	it('replaces the longest spelling first, so a whole key is one placeholder', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_PEM })
		expect(mask?.(FAKE_PEM)).toBe(`[REDACTED · ${NAME}]`)
	})

	it('leaves unrelated text alone', () => {
		const mask = createKeychainMasker({ [NAME]: FAKE_KEY })
		expect(mask?.('{"type":"assistant","text":"hello"}')).toBe(
			'{"type":"assistant","text":"hello"}',
		)
	})
})

describe('redactTokenShapes', () => {
	it('masks token-shaped strings and leaves the rest of the line', () => {
		const out = redactTokenShapes('use ghp_0123456789abcdefABCDEF now')
		expect(out).toBe('use [REDACTED] now')
	})

	it('does not touch key-name assignments such as token counts', () => {
		const line = '{"usage":{"input_tokens":123,"output_tokens":45}}'
		expect(redactTokenShapes(line)).toBe(line)
	})
})
