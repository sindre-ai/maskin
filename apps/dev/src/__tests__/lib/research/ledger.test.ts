import { describe, expect, it } from 'vitest'
import {
	type LedgerFinding,
	buildLedger,
	buildMethodSection,
	fitFindings,
	normalizeUrl,
	parseResearcherOutput,
	postCheckReport,
	quoteInText,
	tier12Share,
} from '../../../lib/research/ledger'

const URL_A = 'https://www.retsinformation.dk/eli/lta/2022/700'
const PAGE = 'Regnskabsmateriale skal opbevares i fem år\n efter regnskabsårets udløb.'

const finding = (over: Record<string, unknown> = {}) => ({
	claim: 'Materialet opbevares i fem år.',
	quote: 'Regnskabsmateriale skal opbevares i fem år efter regnskabsårets udløb.',
	url: URL_A,
	title: 'Bogføringsloven',
	publisher: 'Retsinformation',
	date: '2022-05-24',
	source_type: 'primary',
	confidence: 0.9,
	...over,
})

describe('parseResearcherOutput', () => {
	it('reads the JSON object out of a code fence', () => {
		const out = parseResearcherOutput(
			`Here you go:\n\`\`\`json\n${JSON.stringify({ findings: [finding()], unread: [{ url: 'https://x.dk', reason: 'paywalled' }], gaps: ['no 2024 data'] })}\n\`\`\``,
		)
		expect(out?.findings).toHaveLength(1)
		expect(out?.unread).toEqual([{ url: 'https://x.dk', reason: 'paywalled' }])
		expect(out?.gaps).toEqual(['no 2024 data'])
	})

	it('returns null for text that is not the contract', () => {
		expect(parseResearcherOutput('I could not do it')).toBeNull()
		expect(parseResearcherOutput(null)).toBeNull()
		expect(parseResearcherOutput('{"findings": "none"}')).toBeNull()
	})

	it('skips and counts a finding that breaks the contract', () => {
		const out = parseResearcherOutput(
			JSON.stringify({ findings: [finding(), finding({ source_type: 'great' }), { claim: 'x' }] }),
		)
		expect(out?.findings).toHaveLength(1)
		expect(out?.malformedFindings).toBe(2)
	})
})

describe('quoteInText', () => {
	it('matches across line breaks and repeated spaces', () => {
		expect(quoteInText('opbevares  i fem år efter', PAGE)).toBe(true)
	})

	it('does not match a reworded quote or an empty one', () => {
		expect(quoteInText('opbevares i fem aar', PAGE)).toBe(false)
		expect(quoteInText('   ', PAGE)).toBe(false)
	})
})

describe('buildLedger', () => {
	const fetched = new Map([[normalizeUrl(URL_A), PAGE]])

	it('keeps a finding whose quote is on the fetched page and numbers the source', () => {
		const out = parseResearcherOutput(JSON.stringify({ findings: [finding()] }))
		if (!out) throw new Error('parse')
		const ledger = buildLedger(out, fetched)
		expect(ledger.sources).toEqual([
			{
				n: 1,
				url: URL_A,
				title: 'Bogføringsloven',
				publisher: 'Retsinformation',
				date: '2022-05-24',
				source_type: 'primary',
			},
		])
		expect(ledger.findings.map((f) => f.n)).toEqual([1])
	})

	it('drops a quote that is not on the page, a page never read, and blocked sources', () => {
		const out = parseResearcherOutput(
			JSON.stringify({
				findings: [
					finding({ quote: 'something the page never said' }),
					finding({ url: 'https://other.dk/page' }),
					finding({ source_type: 'blocked' }),
					finding({ url: 'https://seo.example.com/best-2026' }),
				],
			}),
		)
		if (!out) throw new Error('parse')
		const ledger = buildLedger(out, fetched, ['example.com'])
		expect(ledger.findings).toEqual([])
		expect(ledger.dropped).toEqual({ quoteNotFound: 1, notFetched: 1, blocked: 2, malformed: 0 })
	})

	it('gives two findings from one page the same source number, matching despite a trailing slash', () => {
		const out = parseResearcherOutput(
			JSON.stringify({ findings: [finding(), finding({ url: `${URL_A}/` })] }),
		)
		if (!out) throw new Error('parse')
		const ledger = buildLedger(out, fetched)
		expect(ledger.sources).toHaveLength(1)
		expect(ledger.findings.map((f) => f.n)).toEqual([1, 1])
	})

	it('reports the share of tier 1 and 2 sources', () => {
		const share = tier12Share([
			{ n: 1, url: 'a', title: '', publisher: '', date: null, source_type: 'primary' },
			{ n: 2, url: 'b', title: '', publisher: '', date: null, source_type: 'weak' },
		])
		expect(share).toBe(0.5)
		expect(tier12Share([])).toBe(0)
	})
})

describe('postCheckReport', () => {
	const sources = [
		{ n: 1, url: 'a', title: 'A', publisher: '', date: null, source_type: 'primary' as const },
		{ n: 2, url: 'b', title: 'B', publisher: '', date: null, source_type: 'secondary' as const },
	]

	it('strips a citation that is not in the ledger, with its leading space', () => {
		const out = postCheckReport('Five years [1]. See also [9].', sources)
		expect(out.markdown).toBe('Five years [1]. See also.')
		expect(out.warnings.join(' ')).toContain('Removed 1 citation')
	})

	it('lists sources the report never cites', () => {
		const out = postCheckReport('Five years [1].', sources)
		expect(out.warnings).toContain('Sources read but never cited: [2].')
		expect(out.cited).toEqual([1])
	})

	it('flags a sentence with a number and no citation', () => {
		const out = postCheckReport(
			'## TL;DR\nThe fine is 5000 kroner. The law is old [1] [2].',
			sources,
		)
		expect(out.warnings).toContain('1 sentence(s) contain a number but no citation.')
	})

	it('does not flag headings or a cited figure', () => {
		const out = postCheckReport('## Key findings 2026\nThe fine is 5000 kroner [1] [2].', sources)
		expect(out.warnings).toEqual([])
	})
})

describe('fitFindings', () => {
	const f = (n: number, confidence: number): LedgerFinding => ({
		n,
		claim: 'x'.repeat(30),
		quote: 'y',
		confidence,
	})
	const render = (x: LedgerFinding) => x.claim

	it('drops the lowest-confidence findings first and keeps the original order', () => {
		const kept = fitFindings([f(1, 0.2), f(2, 0.9), f(3, 0.6)], 10, render)
		expect(kept.map((x) => x.n)).toEqual([2])
		const two = fitFindings([f(1, 0.2), f(2, 0.9), f(3, 0.6)], 20, render)
		expect(two.map((x) => x.n)).toEqual([2, 3])
	})

	it('keeps everything when it fits', () => {
		expect(fitFindings([f(1, 0.5), f(2, 0.5)], 1000, render)).toHaveLength(2)
	})
})

describe('buildMethodSection', () => {
	it('states effort, queries, unread sources and the budget used', () => {
		const text = buildMethodSection({
			effort: 'simple',
			researchers: 1,
			queries: ['bogføringsloven'],
			sourcesRead: 2,
			unread: [{ url: 'https://x.dk', reason: 'paywalled' }],
			costCents: 7,
			capCents: 100,
		})
		expect(text).toContain('## Method')
		expect(text).toContain('Effort: simple (1 researcher)')
		expect(text).toContain('"bogføringsloven"')
		expect(text).toContain('https://x.dk (paywalled)')
		expect(text).toContain('$0.07 of a $1.00 cap')
	})
})
