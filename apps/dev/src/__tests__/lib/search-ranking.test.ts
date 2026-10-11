import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
	buildCursorCondition,
	buildMatchCondition,
	buildScoreExpr,
	buildSearchTerms,
	compareRanked,
	decodeSearchCursor,
	encodeSearchCursor,
	toSnippet,
} from '../../lib/search/ranking'

const dialect = new PgDialect()
const title = sql`t.title`
const content = sql`t.content`

describe('buildSearchTerms', () => {
	it('drops stopwords and tokens shorter than 3 chars when something meaningful remains', () => {
		expect(buildSearchTerms('The Q3 marketing plan').tokens).toEqual(['marketing', 'plan'])
	})

	it('keeps short tokens when the query is only short tokens', () => {
		expect(buildSearchTerms('Q3').tokens).toEqual(['q3'])
		expect(buildSearchTerms('AI UX').tokens).toEqual(['ai', 'ux'])
	})

	it('falls back to the raw words when every token is a stopword', () => {
		expect(buildSearchTerms('to do').tokens).toEqual(['to', 'do'])
	})

	it('falls back to the whole phrase for punctuation-only queries', () => {
		expect(buildSearchTerms('%%').tokens).toEqual(['%%'])
	})

	it('keeps non-ASCII letters', () => {
		expect(buildSearchTerms('Økonomi på plass').tokens).toEqual(['økonomi', 'plass'])
	})

	it('dedupes and caps the token count', () => {
		expect(buildSearchTerms('plan plan PLAN').tokens).toEqual(['plan'])
		expect(buildSearchTerms('aaa bbb ccc ddd eee fff ggg hhh iii jjj').tokens).toHaveLength(8)
	})

	it('normalises the phrase', () => {
		expect(buildSearchTerms('  Launch   Plan ').phrase).toBe('launch plan')
	})
})

describe('LIKE escaping', () => {
	it('escapes underscores in token patterns', () => {
		const q = dialect.sqlToQuery(
			buildMatchCondition(buildSearchTerms('100% _done'), title, content),
		)
		expect(q.params).toContain('%\\_done%')
	})

	it('escapes every wildcard when the phrase itself is the fallback token', () => {
		const q = dialect.sqlToQuery(buildMatchCondition(buildSearchTerms('%%'), title))
		expect(q.params).toContain('%\\%\\%%')
	})

	it('escapes wildcards in the prefix pattern of the score', () => {
		const q = dialect.sqlToQuery(buildScoreExpr(buildSearchTerms('50%'), title))
		expect(q.params).toContain('50\\%%')
	})

	it('only scores content when a content column is supplied', () => {
		const withContent = dialect.sqlToQuery(buildScoreExpr(buildSearchTerms('plan'), title, content))
		const titleOnly = dialect.sqlToQuery(buildScoreExpr(buildSearchTerms('plan'), title))
		expect(withContent.sql).toContain('t.content')
		expect(titleOnly.sql).not.toContain('t.content')
	})
})

describe('search cursor', () => {
	it('round-trips', () => {
		const cursor = { s: 1234, u: 1760000000123, i: randomUUID() }
		expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor)
	})

	it.each([
		'not-base64-json',
		Buffer.from('{}').toString('base64url'),
		Buffer.from(JSON.stringify({ s: 'x', u: 1, i: randomUUID() })).toString('base64url'),
		Buffer.from(JSON.stringify({ s: 1, u: 1, i: 'nope' })).toString('base64url'),
		Buffer.from(JSON.stringify({ s: 1.5, u: 1, i: randomUUID() })).toString('base64url'),
	])('rejects %s', (raw) => {
		expect(decodeSearchCursor(raw)).toBeNull()
	})

	it('binds the cursor values as parameters', () => {
		const id = randomUUID()
		const q = dialect.sqlToQuery(
			buildCursorCondition({ s: 5, u: 99, i: id }, sql`score`, sql`ms`, sql`t.id`),
		)
		expect(q.params).toEqual(expect.arrayContaining([5, '99', id]))
	})
})

describe('compareRanked', () => {
	it('orders by score desc, then recency desc, then id asc', () => {
		const rows = [
			{ id: 'b', score: 10, ms: 1 },
			{ id: 'a', score: 10, ms: 1 },
			{ id: 'c', score: 10, ms: 2 },
			{ id: 'd', score: 50, ms: 0 },
		]
		expect(rows.sort(compareRanked).map((r) => r.id)).toEqual(['d', 'c', 'a', 'b'])
	})
})

describe('toSnippet', () => {
	it('collapses whitespace and truncates', () => {
		expect(toSnippet('a\n\n b')).toBe('a b')
		expect(toSnippet('x'.repeat(300))?.length).toBe(141)
		expect(toSnippet('   ')).toBeUndefined()
	})
})
