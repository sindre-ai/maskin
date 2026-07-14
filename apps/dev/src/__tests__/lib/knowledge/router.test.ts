import { describe, expect, it } from 'vitest'
import {
	type KnowledgeArticle,
	approxTokens,
	assembleContext,
	assembleFullContext,
	route,
	tokenizeQuery,
} from '../../../lib/knowledge/router'

const v1Article = (over: Partial<KnowledgeArticle> = {}): KnowledgeArticle => ({
	id: '00000000-0000-0000-0000-000000000001',
	title: 'Test',
	body: 'Body text',
	metadata: { format_version: 'v1' },
	...over,
})

describe('tokenizeQuery', () => {
	it('lowercases, drops short tokens and stopwords', () => {
		expect(tokenizeQuery('How does the GitHub App handle a request?')).toEqual([
			'github',
			'app',
			'handle',
			'request',
		])
	})

	it('splits on non-word characters', () => {
		expect(tokenizeQuery('pg_notify payload size')).toEqual(['notify', 'payload', 'size'])
	})
})

describe('route', () => {
	it('filters to v1 articles only', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({
				id: '11111111-0000-0000-0000-000000000001',
				title: 'GitHub tokens',
				metadata: { format_version: 'v1', tags: ['topic:integrations'] },
			}),
			v1Article({
				id: '22222222-0000-0000-0000-000000000002',
				title: 'Pre-v1 GitHub note',
				metadata: { tags: ['topic:integrations'] },
			}),
		]
		const result = route('github', corpus, { topK: 5 })
		expect(result.hits.map((h) => h.article.id)).toEqual(['11111111-0000-0000-0000-000000000001'])
		expect(result.filteredCount).toBe(1)
	})

	it('scores by tag / doc_type / title / summary hits and confidence weight', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({
				id: 'aaaaaaaa-0000-0000-0000-000000000001',
				title: 'Idempotency-Key on write endpoints',
				metadata: {
					format_version: 'v1',
					doc_type: 'reference',
					summary: 'Every write endpoint accepts an Idempotency-Key header.',
					tags: ['topic:architecture'],
					confidence: 'high',
				},
			}),
			v1Article({
				id: 'bbbbbbbb-0000-0000-0000-000000000002',
				title: 'Unrelated topic',
				metadata: {
					format_version: 'v1',
					doc_type: 'note',
					summary: 'Nothing to do with idempotency.',
					tags: ['topic:design-ux'],
					confidence: 'low',
				},
			}),
		]
		const result = route('idempotency key on write endpoints', corpus, { topK: 2 })
		expect(result.hits[0].article.id).toBe('aaaaaaaa-0000-0000-0000-000000000001')
		expect(result.hits[0].score).toBeGreaterThan(0)
	})

	it('is deterministic — repeat calls return identical ordering and scores', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({
				id: '10000000-0000-0000-0000-000000000001',
				title: 'Alpha',
				metadata: { format_version: 'v1', tags: ['topic:code-review'], confidence: 'medium' },
			}),
			v1Article({
				id: '20000000-0000-0000-0000-000000000002',
				title: 'Beta code review',
				metadata: { format_version: 'v1', tags: ['topic:code-review'], confidence: 'medium' },
			}),
		]
		const a = route('code review', corpus, { topK: 2 })
		const b = route('code review', corpus, { topK: 2 })
		expect(a.hits.map((h) => h.article.id)).toEqual(b.hits.map((h) => h.article.id))
		expect(a.hits.map((h) => h.score)).toEqual(b.hits.map((h) => h.score))
	})

	it('drops hits below minScore', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({
				id: '30000000-0000-0000-0000-000000000001',
				title: 'Unrelated',
				metadata: { format_version: 'v1', tags: ['topic:market'], summary: 'x' },
			}),
		]
		const result = route('completely different query about widgets', corpus, {
			topK: 5,
			minScore: 1,
		})
		expect(result.hits).toHaveLength(0)
	})

	it('respects scope filter when provided', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({
				id: '40000000-0000-0000-0000-000000000001',
				title: 'Universal',
				metadata: { format_version: 'v1', tags: ['topic:knowledge-system'], scope: 'universal' },
			}),
			v1Article({
				id: '50000000-0000-0000-0000-000000000002',
				title: 'Workspace',
				metadata: { format_version: 'v1', tags: ['topic:knowledge-system'], scope: 'workspace' },
			}),
		]
		const result = route('knowledge system', corpus, { topK: 5, scope: ['universal'] })
		expect(result.hits.map((h) => h.article.id)).toEqual(['40000000-0000-0000-0000-000000000001'])
	})
})

describe('assembleContext / assembleFullContext', () => {
	it('renders v1 header + body per article', () => {
		const a = v1Article({
			title: 'Doc',
			body: 'Hello.',
			metadata: {
				format_version: 'v1',
				doc_type: 'reference',
				summary: 'A doc.',
				tags: ['topic:x'],
				scope: 'workspace',
				confidence: 'high',
			},
		})
		const out = assembleContext([a])
		expect(out).toContain('# Doc')
		expect(out).toContain('summary: A doc.')
		expect(out).toContain('Hello.')
	})

	it('assembleFullContext skips non-v1 rows', () => {
		const corpus: KnowledgeArticle[] = [
			v1Article({ id: 'x1', title: 'v1' }),
			v1Article({
				id: 'x2',
				title: 'v0',
				metadata: { format_version: undefined, tags: ['topic:x'] },
			}),
		]
		const out = assembleFullContext(corpus)
		expect(out).toContain('# v1')
		expect(out).not.toContain('# v0')
	})
})

describe('approxTokens', () => {
	it('returns 0 for empty', () => {
		expect(approxTokens('')).toBe(0)
	})

	it('scales roughly with character count', () => {
		expect(approxTokens('a'.repeat(4))).toBe(1)
		expect(approxTokens('a'.repeat(400))).toBe(100)
	})
})
