import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
	buildObjectListConditions,
	tokenRankOrderBy,
	tokenizeSearchQuery,
} from '../../routes/objects'

const dialect = new PgDialect()

describe('tokenizeSearchQuery', () => {
	it('returns a single token for a single-word query', () => {
		expect(tokenizeSearchQuery('database')).toEqual(['database'])
	})

	it('returns each distinct token for a multi-token query', () => {
		expect(tokenizeSearchQuery('database migration schema')).toEqual([
			'database',
			'migration',
			'schema',
		])
	})

	it('splits on punctuation as if it were whitespace', () => {
		expect(tokenizeSearchQuery('login,signup;auth!flow')).toEqual([
			'login',
			'signup',
			'auth',
			'flow',
		])
	})

	it('returns [] for empty / whitespace / punctuation-only queries (fall-through)', () => {
		expect(tokenizeSearchQuery('')).toEqual([])
		expect(tokenizeSearchQuery('   ')).toEqual([])
		expect(tokenizeSearchQuery('!!!???...')).toEqual([])
	})

	it('returns [] when every candidate is a stopword', () => {
		expect(tokenizeSearchQuery('the and but with your')).toEqual([])
	})

	it('drops tokens shorter than 3 chars', () => {
		expect(tokenizeSearchQuery('go ai db')).toEqual([])
		expect(tokenizeSearchQuery('go run analysis')).toEqual(['run', 'analysis'])
	})

	it('lowercases input before matching stopwords', () => {
		expect(tokenizeSearchQuery('DATABASE Migration')).toEqual(['database', 'migration'])
		expect(tokenizeSearchQuery('The DATABASE')).toEqual(['database'])
	})

	it('dedupes preserving first-seen order', () => {
		expect(tokenizeSearchQuery('bug bug fix bug crash')).toEqual(['bug', 'fix', 'crash'])
	})

	it('keeps underscores and hyphens intact inside tokens', () => {
		expect(tokenizeSearchQuery('object-search agent_run')).toEqual(['object-search', 'agent_run'])
	})
})

describe('buildObjectListConditions — tokenized ILIKE for q', () => {
	it('adds a per-token ILIKE OR match for a multi-token q', () => {
		const { conditions, searchRankExpr } = buildObjectListConditions({
			q: 'database migration',
			include_archived: true,
		})
		expect(searchRankExpr).not.toBeNull()
		expect(conditions).toHaveLength(1)
		const sqlText = dialect.sqlToQuery(conditions[0] as never).sql
		expect(sqlText.match(/ilike/gi)?.length ?? 0).toBeGreaterThanOrEqual(4)
		expect(sqlText.toLowerCase()).toContain('or')
	})

	it('adds a single ILIKE OR match for a single-token q', () => {
		const { conditions, searchRankExpr } = buildObjectListConditions({
			q: 'database',
			include_archived: true,
		})
		expect(searchRankExpr).not.toBeNull()
		expect(conditions).toHaveLength(1)
		const rendered = dialect.sqlToQuery(conditions[0] as never)
		expect(rendered.sql.match(/ilike/gi)?.length ?? 0).toBe(2)
		expect(rendered.params).toContain('%database%')
	})

	it('does not add a text condition when q is punctuation-only', () => {
		const { conditions, searchRankExpr } = buildObjectListConditions({
			q: '!!! ??? ...',
			include_archived: true,
		})
		expect(searchRankExpr).toBeNull()
		expect(conditions).toEqual([])
	})

	it('does not add a text condition when q is all stopwords', () => {
		const { conditions, searchRankExpr } = buildObjectListConditions({
			q: 'the and of',
			include_archived: true,
		})
		expect(searchRankExpr).toBeNull()
		expect(conditions).toEqual([])
	})

	it('does not add a text condition when q is absent (empty-q fall-through)', () => {
		const { conditions, searchRankExpr } = buildObjectListConditions({
			include_archived: true,
		})
		expect(searchRankExpr).toBeNull()
		expect(conditions).toEqual([])
	})

	it('escapes LIKE metacharacters in tokens so underscores match literally', () => {
		const { conditions } = buildObjectListConditions({ q: 'foo_bar migration' })
		const rendered = dialect.sqlToQuery(conditions[0] as never)
		expect(rendered.params).toContain('%foo\\_bar%')
		expect(rendered.params).toContain('%migration%')
	})
})

describe('tokenRankOrderBy — deterministic tie-break', () => {
	it('orders by rank DESC, then title ASC, then id ASC', () => {
		const { searchRankExpr } = buildObjectListConditions({ q: 'foo bar' })
		expect(searchRankExpr).not.toBeNull()
		const orderBy = tokenRankOrderBy(searchRankExpr as never)
		expect(orderBy).toHaveLength(3)
		const rendered = orderBy.map((expr) => dialect.sqlToQuery(expr as never).sql.toLowerCase())
		expect(rendered[0]).toContain('desc')
		expect(rendered[0]).toContain('case when')
		expect(rendered[1]).toContain('"title"')
		expect(rendered[1]).toContain('asc')
		expect(rendered[2]).toContain('"id"')
		expect(rendered[2]).toContain('asc')
	})

	it('rank expression sums one hit-indicator per token', () => {
		const { searchRankExpr } = buildObjectListConditions({ q: 'alpha beta gamma' })
		expect(searchRankExpr).not.toBeNull()
		const rendered = dialect.sqlToQuery(searchRankExpr as never).sql.toLowerCase()
		expect(rendered.match(/case when/g)?.length ?? 0).toBe(3)
		expect(rendered.match(/ \+ /g)?.length ?? 0).toBe(2)
	})
})
