import { describe, expect, it } from 'vitest'
import {
	ARGS_SUMMARY_CAP_CHARS,
	ERROR_MESSAGE_CHARS,
	MAX_ARRAY_ITEMS,
	OUTPUT_PREVIEW_CHARS,
	STRING_CAP,
	capErrorMessage,
	maskSensitiveText,
	previewToolOutput,
	redactValue,
	summarizeToolArgs,
} from '../../lib/voice-tool-call-redaction'

describe('redactValue', () => {
	it('keeps ids, numbers and short strings', () => {
		const args = {
			ids: ['6cae4b5d-ce70-4254-9f91-8d3a0e24b775'],
			limit: 5,
			archived: false,
			q: 'loops',
		}
		expect(redactValue(args)).toEqual(args)
	})

	it('drops the value of keys that look like secrets, however they are spelled', () => {
		const out = redactValue({
			api_key: 'abc',
			apiKey: 'abc',
			'API-KEY': 'abc',
			Authorization: 'Bearer abc',
			access_token: 'abc',
			password: 'hunter2',
			client_secret: 'abc',
			session_cookie: 'abc',
			name: 'kept',
		}) as Record<string, unknown>
		expect(
			Object.entries(out)
				.filter(([k]) => k !== 'name')
				.every(([, v]) => v === '[redacted]'),
		).toBe(true)
		expect(out.name).toBe('kept')
	})

	it('keeps only the length of content-bearing keys', () => {
		expect(
			redactValue({ body: 'Dear Lars, here is the contract', html: '<p>x</p>', data: { a: 1 } }),
		).toEqual({ body: '[31 chars]', html: '[8 chars]', data: '[object]' })
	})

	it('cuts other long strings and says how much was cut', () => {
		const out = redactValue({ title: 'a'.repeat(STRING_CAP + 50) }) as { title: string }
		expect(out.title.startsWith('a'.repeat(STRING_CAP))).toBe(true)
		expect(out.title).toContain('[+50 chars]')
	})

	it('masks credentials and email addresses inside strings', () => {
		const out = redactValue({
			note_to: 'ping lars@example.dk with ank_abcdef123456 and Bearer abcdefgh12345678',
		}) as { note_to: string }
		expect(out.note_to).not.toContain('lars@example.dk')
		expect(out.note_to).not.toContain('ank_abcdef123456')
		expect(out.note_to).not.toContain('abcdefgh12345678')
		expect(out.note_to).toContain('[email]')
	})

	it('redacts inside nested objects and arrays of objects', () => {
		const out = redactValue({
			items: [{ id: 'a', token: 'zzz', nested: { password: 'p', ok: 1 } }],
		}) as { items: Array<Record<string, unknown>> }
		expect(out.items[0]).toEqual({
			id: 'a',
			token: '[redacted]',
			nested: { password: '[redacted]', ok: 1 },
		})
	})

	it('bounds arrays, depth and key count', () => {
		const arr = redactValue(Array.from({ length: 25 }, (_, i) => i)) as unknown[]
		expect(arr).toHaveLength(MAX_ARRAY_ITEMS + 1)
		expect(arr.at(-1)).toBe('…[+15 items]')

		const deep = redactValue({ a: { b: { c: { d: { e: 1 } } } } })
		expect(JSON.stringify(deep)).toContain('[object]')
		expect(JSON.stringify(deep)).not.toContain('"e"')

		const wide = redactValue(
			Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
		) as Record<string, unknown>
		expect(Object.keys(wide)).toHaveLength(31)
		expect(wide._more_keys).toBe(20)
	})

	it('handles null, undefined and a cyclic object without throwing', () => {
		const cyclic: Record<string, unknown> = { id: 'x' }
		cyclic.self = cyclic
		expect(() => redactValue(cyclic)).not.toThrow()
		expect(redactValue(null)).toBeNull()
		expect(redactValue(undefined)).toBeNull()
	})
})

describe('summarizeToolArgs', () => {
	it('replaces an oversized summary with its size and key names', () => {
		const args = Object.fromEntries(
			Array.from({ length: 30 }, (_, i) => [`field_${i}`, 'v'.repeat(STRING_CAP)]),
		)
		const out = summarizeToolArgs(args) as { _truncated: boolean; chars: number; keys: string[] }
		expect(out._truncated).toBe(true)
		expect(out.chars).toBeGreaterThan(ARGS_SUMMARY_CAP_CHARS)
		expect(out.keys).toContain('field_0')
	})

	it('stores a non-object argument payload as a capped string', () => {
		expect(summarizeToolArgs('{not json')).toBe('{not json')
		expect(summarizeToolArgs('z'.repeat(1000)) as string).toHaveLength(
			STRING_CAP + '…[+800 chars]'.length,
		)
	})
})

describe('previewToolOutput', () => {
	it('keeps the error of a failed call readable', () => {
		const out = previewToolOutput(
			JSON.stringify({ error: 'invalid id: abc', error_code: 'voice_tool_failed' }),
		)
		expect(out).toContain('invalid id: abc')
		expect(out).toContain('voice_tool_failed')
	})

	it('shows only the length of content fields in a JSON result', () => {
		const out = previewToolOutput(
			JSON.stringify({
				results: [{ id: 'a', title: 'Loops', content: 'secret plans '.repeat(20) }],
			}),
		)
		expect(out).toContain('"title":"Loops"')
		expect(out).not.toContain('secret plans')
		expect(out).toContain('[260 chars]')
	})

	it('elides content fields in a JSON output that the cap cut off mid-string', () => {
		const full = JSON.stringify({ results: [{ id: 'a', content: 'private text '.repeat(3000) }] })
		const out = previewToolOutput(`${full.slice(0, 20000)}… [truncated]`)
		expect(out).toContain('"id":"a"')
		expect(out).not.toContain('private text')
	})

	it('masks secrets in text that is not JSON and cuts at the preview size', () => {
		const out = previewToolOutput(`token: "abc123" ${'y'.repeat(2000)}`)
		expect(out).not.toContain('abc123')
		expect(out.length).toBeLessThanOrEqual(OUTPUT_PREVIEW_CHARS)
	})
})

describe('capErrorMessage', () => {
	it('returns null for nothing, masks and caps otherwise', () => {
		expect(capErrorMessage(null)).toBeNull()
		expect(capErrorMessage('')).toBeNull()
		const out = capErrorMessage(`failed for a@b.com ${'e'.repeat(1000)}`) as string
		expect(out).toContain('[email]')
		expect(out.length).toBe(ERROR_MESSAGE_CHARS)
	})
})

describe('maskSensitiveText', () => {
	it('masks provider-style keys and JWTs', () => {
		const text =
			'sk-abcdefghijklmnopqrst xoxb-12345678-abc ghp_abcdefghijklmnopqrstuvwx eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'
		const out = maskSensitiveText(text)
		expect(out).toBe('[redacted] [redacted] [redacted] [redacted]')
	})
})
