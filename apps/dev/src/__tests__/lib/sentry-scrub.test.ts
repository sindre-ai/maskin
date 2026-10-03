import type { Breadcrumb, ErrorEvent, Log } from '@sentry/node'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import {
	scrubBreadcrumb,
	scrubEvent,
	scrubLog,
	scrubString,
	scrubValue,
} from '../../lib/sentry-scrub'

// Fake values only, on purpose obviously fake.
const SQL = 'update "sessions" set "token" = $1, "hash" = $2 where "id" = $3'
const FAILED = `Failed query: ${SQL}\nparams: fake-token-0000,fake-hash-0000,00000000-0000-0000-0000-000000000000`
const SCRUBBED = `Failed query: ${SQL}\nparams: [redacted]`

function expectNoValues(serialized: string) {
	expect(serialized).not.toContain('fake-token-0000')
	expect(serialized).not.toContain('fake-hash-0000')
}

describe('scrubString', () => {
	it('keeps the SQL and removes every bound value (rule 1)', () => {
		expect(scrubString(FAILED)).toBe(SCRUBBED)
	})

	it('cuts to the end of the string even when values hold commas and newlines', () => {
		const input = `Failed query: ${SQL}\nparams: fake-token-0000,line one\nline two, fake-hash-0000`
		expect(scrubString(input)).toBe(SCRUBBED)
	})

	it('keeps text before the Failed query prefix', () => {
		expect(scrubString(`sweep failed: ${FAILED}`)).toBe(`sweep failed: ${SCRUBBED}`)
	})

	it('leaves params: alone when there is no Failed query prefix', () => {
		const input = 'request params: fake-token-0000'
		expect(scrubString(input)).toBe(input)
		const multiline = 'something\nparams: fake-token-0000'
		expect(scrubString(multiline)).toBe(multiline)
	})

	it('leaves Failed query alone when there is no params line', () => {
		const input = `Failed query: ${SQL}`
		expect(scrubString(input)).toBe(input)
	})

	it('returns a string with no markers unchanged', () => {
		const input = 'reaper pass finished in 12ms'
		expect(scrubString(input)).toBe(input)
	})

	it('redacts the value in Postgres Key (col)=(value) detail and keeps the column (rule 2)', () => {
		expect(scrubString('Key (token)=(fake-token-0000) already exists.')).toBe(
			'Key (token)=([redacted]) already exists.',
		)
		expect(scrubString('Key (a, b)=(fake-a, fake-b) is not present in table "x".')).toBe(
			'Key (a, b)=([redacted]) is not present in table "x".',
		)
	})

	it('redacts a Postgres detail value that contains a closing parenthesis', () => {
		expect(scrubString('Key (token)=(fake-token-0000) tail) already exists.')).toBe(
			'Key (token)=([redacted]) already exists.',
		)
	})

	it('still matches the message format of the installed drizzle-orm', () => {
		const err = new DrizzleQueryError(SQL, ['fake-token-0000', 'fake-hash-0000'], new Error('boom'))
		const scrubbed = scrubString(err.message)
		expect(scrubbed).toContain(SQL)
		expect(scrubbed).toContain('params: [redacted]')
		expectNoValues(scrubbed)
	})
})

describe('scrubValue', () => {
	it('scrubs strings nested in objects and arrays, keeping keys', () => {
		const out = scrubValue({ err: FAILED, nested: { list: ['ok', FAILED] }, n: 1 })
		expect(out).toEqual({ err: SCRUBBED, nested: { list: ['ok', SCRUBBED] }, n: 1 })
	})

	it('returns the same reference when nothing needed scrubbing', () => {
		const input = { a: 'fine', b: { c: ['x', 2, null] } }
		expect(scrubValue(input)).toBe(input)
	})

	it('does not mutate its input', () => {
		const input = { err: FAILED }
		scrubValue(input)
		expect(input.err).toBe(FAILED)
	})

	it('drops containers past the depth cap instead of sending them unscrubbed', () => {
		const deep = { a: { b: { c: { d: { e: { f: FAILED } } } } } }
		const out = JSON.stringify(scrubValue(deep))
		expectNoValues(out)
	})

	it('survives a circular structure', () => {
		const loop: Record<string, unknown> = { err: FAILED }
		loop.self = loop
		expectNoValues(JSON.stringify(scrubValue(loop)))
	})

	it('passes primitives and undefined through', () => {
		expect(scrubValue(undefined)).toBeUndefined()
		expect(scrubValue(null)).toBeNull()
		expect(scrubValue(5)).toBe(5)
	})
})

describe('scrubLog (beforeSendLog)', () => {
	it('scrubs the message and nested attributes', () => {
		const log: Log = {
			level: 'warn',
			message: `step failed: ${FAILED}`,
			attributes: { error: FAILED, ctx: { inner: FAILED }, count: 3 },
		}
		const out = scrubLog(log)
		expect(out?.message).toBe(`step failed: ${SCRUBBED}`)
		expect(out?.attributes).toEqual({ error: SCRUBBED, ctx: { inner: SCRUBBED }, count: 3 })
		expect(out?.level).toBe('warn')
	})

	it('copes with a log that has no attributes', () => {
		expect(scrubLog({ level: 'info', message: 'plain' })?.message).toBe('plain')
	})

	it('drops the log when scrubbing throws', () => {
		const log = {
			level: 'info',
			get message(): string {
				throw new Error('boom')
			},
		} as unknown as Log
		expect(scrubLog(log)).toBeNull()
	})
})

describe('scrubBreadcrumb (beforeBreadcrumb)', () => {
	it('scrubs message and data', () => {
		const crumb: Breadcrumb = { category: 'log', message: FAILED, data: { error: FAILED } }
		const out = scrubBreadcrumb(crumb)
		expect(out?.message).toBe(SCRUBBED)
		expect(out?.data).toEqual({ error: SCRUBBED })
		expect(out?.category).toBe('log')
	})

	it('drops the breadcrumb when scrubbing throws', () => {
		const crumb = {
			get message(): string {
				throw new Error('boom')
			},
		} as unknown as Breadcrumb
		expect(scrubBreadcrumb(crumb)).toBeNull()
	})
})

describe('scrubEvent (beforeSend)', () => {
	function fakeEvent(): ErrorEvent {
		return {
			type: undefined,
			message: FAILED,
			extra: { context: { error: FAILED }, retries: 2 },
			exception: {
				values: [
					{ type: 'Error', value: 'wrapper error' },
					{ type: 'DrizzleQueryError', value: FAILED },
				],
			},
			breadcrumbs: [{ category: 'log', message: FAILED, data: { error: FAILED } }],
		}
	}

	it('scrubs message, extra, every exception value and breadcrumbs', () => {
		const out = scrubEvent(fakeEvent())
		expect(out?.message).toBe(SCRUBBED)
		expect(out?.extra).toEqual({ context: { error: SCRUBBED }, retries: 2 })
		expect(out?.exception?.values?.map((v) => v.value)).toEqual(['wrapper error', SCRUBBED])
		expect(out?.breadcrumbs?.[0]?.message).toBe(SCRUBBED)
		expect(out?.breadcrumbs?.[0]?.data).toEqual({ error: SCRUBBED })
		expectNoValues(JSON.stringify(out))
	})

	it('handles an event with no message, extra, exception or breadcrumbs', () => {
		const out = scrubEvent({ type: undefined })
		expect(out).not.toBeNull()
		expect(out?.exception).toBeUndefined()
	})

	it('sends the event with every free-text field removed when scrubbing throws', () => {
		const event = fakeEvent()
		const extra = event.extra
		let reads = 0
		// Throws on the first read only, so the scrub fails but the fallback can still copy the event.
		Object.defineProperty(event, 'extra', {
			get() {
				reads += 1
				if (reads === 1) throw new Error('boom')
				return extra
			},
			enumerable: true,
		})
		const out = scrubEvent(event)
		expect(out).not.toBeNull()
		expect(out?.message).toBeUndefined()
		expect(out?.extra).toBeUndefined()
		expect(out?.breadcrumbs).toBeUndefined()
		expect(out?.exception?.values?.every((v) => v.value === undefined)).toBe(true)
		expectNoValues(JSON.stringify(out))
	})
})
