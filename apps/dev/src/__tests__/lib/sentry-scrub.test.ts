import type { Breadcrumb, ErrorEvent, Log } from '@sentry/node'
import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	scrubBreadcrumbHook,
	scrubDeep,
	scrubEvent,
	scrubLog,
	scrubString,
} from '../../lib/sentry-scrub'

const SQL = 'insert into "tokens" ("hash", "token") values ($1, $2)'
const FAKE_TOKEN = 'fake-token-0000'
const FAKE_HASH = 'fake-hash-1111'
const failedQuery = (sql = SQL, params = `${FAKE_HASH},${FAKE_TOKEN}`) =>
	`Failed query: ${sql}\nparams: ${params}`
const SCRUBBED = `Failed query: ${SQL}\nparams: [redacted]`

function expectNoValues(payload: unknown) {
	const text = JSON.stringify(payload)
	expect(text).not.toContain(FAKE_TOKEN)
	expect(text).not.toContain(FAKE_HASH)
}

describe('scrubString', () => {
	it('keeps the SQL and drops every bound value (drizzle rule)', () => {
		expect(scrubString(failedQuery())).toBe(SCRUBBED)
	})

	it('covers lowercase select statements', () => {
		const sql = 'select "id" from "actors" where "api_key" = $1 and "id" = $2'
		expect(scrubString(failedQuery(sql, `${FAKE_TOKEN}, ${FAKE_HASH}`))).toBe(
			`Failed query: ${sql}\nparams: [redacted]`,
		)
	})

	it('cuts to the end of the string, including values with commas and newlines', () => {
		const out = scrubString(failedQuery(SQL, `${FAKE_HASH},line one\nline two, ${FAKE_TOKEN}`))
		expect(out).toBe(SCRUBBED)
	})

	it('keeps text before the Failed query marker', () => {
		expect(scrubString(`reaper failed: ${failedQuery()}`)).toBe(`reaper failed: ${SCRUBBED}`)
	})

	it('returns a string with params: but no Failed query: prefix unchanged', () => {
		const input = `request params: ${FAKE_TOKEN}`
		expect(scrubString(input)).toBe(input)
		const multiline = `something\nparams: ${FAKE_TOKEN}`
		expect(scrubString(multiline)).toBe(multiline)
	})

	it('returns a string with Failed query: but no params line unchanged', () => {
		const input = 'Failed query: select 1'
		expect(scrubString(input)).toBe(input)
	})

	it('returns a string with no markers as the same reference', () => {
		const input = 'plain text, nothing to see'
		expect(scrubString(input)).toBe(input)
	})

	it('blanks the value in postgres Key (col)=(value) detail and keeps the column', () => {
		expect(scrubString(`Key (token_hash)=(${FAKE_HASH}) already exists.`)).toBe(
			'Key (token_hash)=([redacted]) already exists.',
		)
		expect(scrubString(`Key (a_id)=(${FAKE_TOKEN}) is not present in table "actors".`)).toBe(
			'Key (a_id)=([redacted]) is not present in table "actors".',
		)
	})

	it('blanks a postgres key value that itself contains a closing paren', () => {
		const out = scrubString(`Key (name)=(${FAKE_TOKEN}) tail) already exists.`)
		expect(out).toBe('Key (name)=([redacted]) already exists.')
	})
})

describe('scrubDeep', () => {
	it('scrubs nested strings, never rewrites keys, and does not mutate the input', () => {
		const input = { error: failedQuery(), nested: { list: [failedQuery(), 7, null] }, n: 1 }
		const snapshot = JSON.stringify(input)
		const out = scrubDeep(input) as typeof input
		expect(out).toEqual({ error: SCRUBBED, nested: { list: [SCRUBBED, 7, null] }, n: 1 })
		expect(JSON.stringify(input)).toBe(snapshot)
	})

	it('reduces an Error to name, message, stack and cause without own props like params', () => {
		const err = Object.assign(new Error(failedQuery()), { params: [FAKE_TOKEN] })
		const out = scrubDeep({ err }) as { err: { message: string } }
		expect(out.err.message).toBe(SCRUBBED)
		expectNoValues(out)
	})

	it('replaces containers nested past the depth cap instead of passing them through', () => {
		let deep: unknown = { leaf: FAKE_TOKEN }
		for (let i = 0; i < 8; i++) deep = { next: deep }
		expectNoValues(scrubDeep(deep))
	})

	it('still scrubs a string at the deepest allowed level', () => {
		const out = scrubDeep({ a: { b: { c: { d: failedQuery() } } } })
		expect(out).toEqual({ a: { b: { c: { d: SCRUBBED } } } })
	})
})

describe('scrubLog (beforeSendLog)', () => {
	it('scrubs the error attribute and every other string attribute', () => {
		const log: Log = {
			level: 'warn',
			message: `step failed: ${failedQuery()}`,
			attributes: {
				error: failedQuery(),
				reason: failedQuery(),
				other: { inner: failedQuery() },
				count: 3,
			},
		}
		const out = scrubLog(log)
		expect(out?.message).toBe(`step failed: ${SCRUBBED}`)
		expect(out?.attributes).toEqual({
			error: SCRUBBED,
			reason: SCRUBBED,
			other: { inner: SCRUBBED },
			count: 3,
		})
		expect(out?.level).toBe('warn')
		expectNoValues(out)
	})

	it('handles a log with no attributes', () => {
		expect(scrubLog({ level: 'info', message: 'hello' })).toEqual({
			level: 'info',
			message: 'hello',
			attributes: undefined,
		})
	})

	it('drops the log when the scrub throws', () => {
		const attributes = {}
		Object.defineProperty(attributes, 'boom', {
			enumerable: true,
			get() {
				throw new Error('boom')
			},
		})
		expect(scrubLog({ level: 'warn', message: 'x', attributes })).toBeNull()
	})
})

describe('scrubBreadcrumbHook (beforeBreadcrumb)', () => {
	it('scrubs message and data', () => {
		const crumb: Breadcrumb = {
			category: 'log',
			message: failedQuery(),
			data: { error: failedQuery(), n: 1 },
		}
		const out = scrubBreadcrumbHook(crumb)
		expect(out).toEqual({
			category: 'log',
			message: SCRUBBED,
			data: { error: SCRUBBED, n: 1 },
		})
	})

	it('drops the breadcrumb when the scrub throws', () => {
		const data = {}
		Object.defineProperty(data, 'boom', {
			enumerable: true,
			get() {
				throw new Error('boom')
			},
		})
		expect(scrubBreadcrumbHook({ message: 'x', data })).toBeNull()
	})
})

describe('scrubEvent (beforeSend)', () => {
	const makeEvent = (): ErrorEvent => ({
		type: undefined,
		message: failedQuery(),
		extra: { error: failedQuery(), nested: { text: failedQuery() } },
		exception: {
			values: [
				{ type: 'Error', value: 'outer wrapper' },
				{ type: 'DrizzleQueryError', value: failedQuery() },
			],
		},
		breadcrumbs: [{ category: 'log', message: failedQuery(), data: { error: failedQuery() } }],
	})

	it('scrubs message, extra, every exception value and breadcrumbs', () => {
		const out = scrubEvent(makeEvent())
		expect(out?.message).toBe(SCRUBBED)
		expect(out?.extra).toEqual({ error: SCRUBBED, nested: { text: SCRUBBED } })
		expect(out?.exception?.values?.map((v) => v.value)).toEqual(['outer wrapper', SCRUBBED])
		expect(out?.breadcrumbs?.[0]).toEqual({
			category: 'log',
			message: SCRUBBED,
			data: { error: SCRUBBED },
		})
		expectNoValues(out)
	})

	it('copes with an event that has none of the optional fields', () => {
		expect(scrubEvent({ type: undefined })).toMatchObject({ type: undefined })
	})

	it('sends the event without free text when the scrub throws, never unscrubbed', () => {
		const event = makeEvent()
		const extra = {}
		Object.defineProperty(extra, 'boom', {
			enumerable: true,
			get() {
				throw new Error('boom')
			},
		})
		event.extra = extra
		const out = scrubEvent(event)
		expect(out).not.toBeNull()
		expect(out?.message).toBeUndefined()
		expect(out?.extra).toBeUndefined()
		expect(out?.breadcrumbs).toBeUndefined()
		expect(out?.exception?.values?.every((v) => v.value === undefined)).toBe(true)
		expectNoValues(out)
	})
})

describe('drizzle-orm message format (canary)', () => {
	it('still builds the message that rule 1 matches, so a drizzle upgrade fails loudly', () => {
		const err = new DrizzleQueryError(SQL, [FAKE_HASH, FAKE_TOKEN], new Error('driver'))
		expect(err.message.startsWith('Failed query: ')).toBe(true)
		expect(err.message).toContain('\nparams: ')
		expect(scrubString(err.message)).toBe(SCRUBBED)
	})
})
