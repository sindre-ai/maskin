import { buildReviewItems, splitBlocks, stripMarkdown, wordDiff } from '@/lib/change-review'
import { describe, expect, it } from 'vitest'

const DOC = [
	'# Title',
	'',
	'First paragraph.',
	'',
	'Second paragraph with **bold** text.',
	'',
	'Third paragraph.',
	'',
	'Fourth paragraph.',
	'',
	'Fifth paragraph.',
].join('\n')

describe('splitBlocks', () => {
	it('splits on blank lines and records offsets', () => {
		const blocks = splitBlocks(DOC)
		expect(blocks.map((b) => b.text)).toEqual([
			'# Title',
			'First paragraph.',
			'Second paragraph with **bold** text.',
			'Third paragraph.',
			'Fourth paragraph.',
			'Fifth paragraph.',
		])
		for (const b of blocks) expect(DOC.slice(b.start, b.end)).toBe(b.text)
	})

	it('keeps a code fence with blank lines inside as one block', () => {
		const text = 'Before\n\n```js\na\n\nb\n```\n\nAfter'
		expect(splitBlocks(text).map((b) => b.text)).toEqual(['Before', '```js\na\n\nb\n```', 'After'])
	})
})

describe('stripMarkdown', () => {
	it('removes headings, emphasis, links and list markers', () => {
		expect(stripMarkdown('## A [link](http://x) and **bold**')).toBe('A link and bold')
		expect(stripMarkdown('- [ ] item one\n- item two')).toBe('item one item two')
	})
})

describe('buildReviewItems', () => {
	it('puts the card where the old text sits, with the neighbouring blocks as context', () => {
		const items = buildReviewItems(DOC, [{ id: 'c1', oldText: 'Third paragraph.', ordinal: 0 }])
		expect(items).toEqual([
			{ kind: 'gap', key: 'gap-2', count: 2 },
			{ kind: 'context', key: 'ctx-2', text: 'Second paragraph with bold text.' },
			{ kind: 'change', key: 'c1', changeId: 'c1', number: 1 },
			{ kind: 'context', key: 'ctx-4', text: 'Fourth paragraph.' },
			{ kind: 'gap', key: 'gap-end', count: 1 },
		])
	})

	it('numbers cards in document order, not submit order', () => {
		const items = buildReviewItems(DOC, [
			{ id: 'late', oldText: 'Fifth paragraph.', ordinal: 0 },
			{ id: 'early', oldText: 'First paragraph.', ordinal: 1 },
		])
		const cards = items.filter((i) => i.kind === 'change')
		expect(cards.map((c) => (c.kind === 'change' ? [c.changeId, c.number] : []))).toEqual([
			['early', 1],
			['late', 2],
		])
	})

	it('puts two changes in one paragraph side by side without context between them', () => {
		const doc = 'Alpha beta gamma delta.'
		const items = buildReviewItems(doc, [
			{ id: 'b', oldText: 'delta', ordinal: 1 },
			{ id: 'a', oldText: 'beta', ordinal: 0 },
		])
		expect(items.map((i) => i.kind)).toEqual(['change', 'change'])
		expect(items[0]).toMatchObject({ changeId: 'a', number: 1 })
	})

	it('leaves out a change whose old text no longer occurs exactly once', () => {
		const doc = 'Same.\n\nSame.\n\nOther.'
		expect(buildReviewItems(doc, [{ id: 'dup', oldText: 'Same.', ordinal: 0 }])).toEqual([
			{ kind: 'gap', key: 'gap-end', count: 3 },
		])
		expect(buildReviewItems(doc, [{ id: 'gone', oldText: 'Missing', ordinal: 0 }])).toHaveLength(1)
	})
})

describe('wordDiff', () => {
	it('marks removed and added words and keeps the rest', () => {
		const parts = wordDiff('The quick brown fox', 'The slow brown fox')
		expect(parts.map((p) => [p.type, p.text.trim()])).toEqual([
			['same', 'The'],
			['del', 'quick'],
			['ins', 'slow'],
			['same', 'brown fox'],
		])
	})

	it('returns one same part for identical text and a pure insert for an empty before', () => {
		expect(wordDiff('a b', 'a b')).toEqual([{ type: 'same', text: 'a b' }])
		expect(wordDiff('', 'new words')).toEqual([{ type: 'ins', text: 'new words' }])
	})
})
