import { describe, expect, it } from 'vitest'
import { createSentenceChunker } from '../../lib/sentence-chunker'
import { toLiveSpeech, toSpeakableText } from '../../lib/speakable-text'

// These inputs are copied from apps/apple/Tests/MaskinCoreTests/Speech/SpeakableTextTests.swift.
describe('toSpeakableText (parity with the iOS SpeakableText)', () => {
	it('strips headings, emphasis, inline code and list markers', () => {
		const md = '# Plan\n\n**Bold** and _italic_ with `code`.\n- one\n- two\n1. first'
		expect(toSpeakableText(md)).toBe('Plan\n\nBold and italic with code.\none\ntwo\nfirst')
	})

	it('keeps link labels, drops urls and images', () => {
		const md = 'See [the docs](https://x.io/a) or https://x.io/b ![chart](https://x.io/c.png)'
		expect(toSpeakableText(md)).toBe('See the docs or link')
	})

	it('replaces fenced code with one short note', () => {
		const md = 'Run:\n```sh\npnpm test\n```\nthen\n```\nmore\n```\ndone'
		expect(toSpeakableText(md)).toBe('Run:\nCode block skipped.\nthen\ndone')
	})

	it('reads tables as cells and drops separators and rules', () => {
		const md = '| Name | Count |\n| --- | --- |\n| Relay | 3 |\n\n---\nEnd'
		expect(toSpeakableText(md)).toBe('Name, Count\nRelay, 3\n\nEnd')
	})

	it('keeps snake_case and arithmetic intact', () => {
		expect(toSpeakableText('use my_var_name and 2*3*4')).toBe('use my_var_name and 2*3*4')
	})

	it('yields empty text for empty markup', () => {
		expect(toSpeakableText('```\ncode\n```')).toBe('Code block skipped.')
		expect(toSpeakableText('   \n')).toBe('')
	})
})

describe('toLiveSpeech', () => {
	it('drops UUIDs and tidies the gap they leave', () => {
		const id = '11111111-2222-4333-8444-555555555555'
		expect(toLiveSpeech(`The bet ${id} is blocked.`)).toBe('The bet is blocked.')
		expect(toLiveSpeech(`Check ${id}, then continue.`)).toBe('Check, then continue.')
	})
})

function chunk(deltas: string[], opts?: Parameters<typeof createSentenceChunker>[0]) {
	const c = createSentenceChunker(opts)
	const out: string[] = []
	for (const d of deltas) out.push(...c.push(d))
	out.push(...c.flush())
	return out
}

describe('createSentenceChunker', () => {
	it('releases a sentence only once the next character has arrived', () => {
		const c = createSentenceChunker({ minChars: 5 })
		expect(c.push('The retry window is seven days.')).toEqual([])
		expect(c.push(' It')).toEqual(['The retry window is seven days.'])
		expect(c.flush()).toEqual(['It'])
	})

	it('does not split inside decimals or abbreviations', () => {
		expect(
			chunk(['Revenue grew 3.5 percent, e.g. in Denmark and Norway. Next topic starts here.']),
		).toEqual(['Revenue grew 3.5 percent, e.g. in Denmark and Norway.', 'Next topic starts here.'])
	})

	it('does not split on an initial or a title', () => {
		expect(chunk(['Ask J. Smith about it today. Then Dr. Hansen will reply soon.'])).toEqual([
			'Ask J. Smith about it today.',
			'Then Dr. Hansen will reply soon.',
		])
	})

	it('merges short fragments forward', () => {
		expect(chunk(['Yes. I checked the numbers and they hold up. Good.'], { minChars: 24 })).toEqual(
			['Yes. I checked the numbers and they hold up.', 'Good.'],
		)
	})

	it('handles streaming token by token', () => {
		const text = 'The first sentence is right here. The second sentence is here too.'
		expect(chunk(text.split(/(?<=\s)/))).toEqual([
			'The first sentence is right here.',
			'The second sentence is here too.',
		])
	})

	it('splits on line breaks so list items are spoken one at a time', () => {
		expect(
			chunk(
				['The first thing worth knowing is this\nThe second thing worth knowing is that\nlast'],
				{ minChars: 10 },
			),
		).toEqual([
			'The first thing worth knowing is this',
			'The second thing worth knowing is that',
			'last',
		])
	})

	it('splits an overlong run at a comma, then a space', () => {
		const long = `${'word '.repeat(30)}, ${'more '.repeat(30)}`
		const parts = chunk([long], { minChars: 10, maxChars: 100 })
		expect(parts.length).toBeGreaterThan(1)
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(101)
	})

	it('keeps closing quotes with their sentence', () => {
		expect(chunk(['She said "we ship on Friday." Then everyone nodded and left.'])).toEqual([
			'She said "we ship on Friday."',
			'Then everyone nodded and left.',
		])
	})

	it('emits nothing for whitespace only', () => {
		expect(chunk(['   ', '\n'])).toEqual([])
	})
})
