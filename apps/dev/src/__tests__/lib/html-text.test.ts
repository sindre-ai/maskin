import { describe, expect, it } from 'vitest'
import { extractHtmlText, readableWithHint } from '../../lib/html-text'
import { buildBriefingDeck } from '../fixtures/briefing-deck'

describe('extractHtmlText', () => {
	const result = extractHtmlText(buildBriefingDeck({ fontChars: 4000 }))

	it('reads title, meta description and JSON-LD', () => {
		expect(result.title).toBe('Weekly readout, 27 Oct')
		expect(result.description).toBe('What we learned this week')
		expect(result.jsonLd).toEqual([{ '@type': 'Report', name: 'Weekly readout' }])
	})

	it('writes one block per slide with its heading', () => {
		expect(result.contentText).toMatch(/Slide 1[\s\S]*## Plumbing is no moat/)
		expect(result.contentText).toMatch(/---\s*\nSlide 2[\s\S]*## Trends/)
	})

	it('keeps bullets, bold and links as markdown', () => {
		expect(result.contentText).toContain(
			'- Market | **Vendors ship the teammate layer** and its consent rules.',
		)
		expect(result.contentText).toContain('[setup](https://example.com/setup)')
	})

	it('keeps a row of spans on one line and renders real tables', () => {
		expect(result.contentText).toContain('# | Trend | Confidence')
		expect(result.contentText).toContain('1 | Consent is the default | High')
		expect(result.contentText).toContain('| Who | Stars |')
		expect(result.contentText).toContain('| Closedloop | 19 |')
	})

	it('appends data-notes under their slide', () => {
		expect(result.contentText).toContain(
			'Notes: Source: the discovery readouts. Confidence is medium.',
		)
	})

	it('drops styles, scripts, svg, buttons and data: URIs', () => {
		for (const gone of [
			'QUJD',
			'font-face',
			'SECRET_SCRIPT',
			'SVG-ONLY-TEXT',
			'Previous slide',
			'data:',
		]) {
			expect(result.contentText).not.toContain(gone)
		}
	})

	it('is a small fraction of a deck that is mostly fonts', () => {
		const html = buildBriefingDeck({ fontChars: 500_000 })
		const out = extractHtmlText(html)
		expect(html.length).toBeGreaterThan(500_000)
		expect(out.contentText.length).toBeLessThan(2_000)
	})

	it('returns the deck-source markdown verbatim when the file carries one', () => {
		const source = '# Deck\n\n- one <b>literal</b>\n'
		const out = extractHtmlText(buildBriefingDeck({ deckSource: source }))
		expect(out.fromDeckSource).toBe(true)
		expect(out.contentText).toBe(source.trim())
		expect(out.title).toBe('Weekly readout, 27 Oct')
	})

	it('handles a fragment with no body, no slides and an empty page', () => {
		expect(extractHtmlText('<p>Hello <em>there</em></p>').contentText).toBe('Hello there')
		expect(extractHtmlText('').contentText).toBe('')
	})

	it('never prints javascript: or data: link targets', () => {
		const out = extractHtmlText(
			'<a href="javascript:alert(1)">x</a> <a href="data:text/html,hi">y</a>',
		)
		expect(out.contentText).toBe('x y')
	})

	it('keeps unparseable JSON-LD as raw text', () => {
		const out = extractHtmlText('<script type="application/ld+json">{nope</script><p>a</p>')
		expect(out.jsonLd).toEqual(['{nope'])
	})
})

describe('readableWithHint', () => {
	it('names format=text and the share of embedded fonts for a big font-heavy deck', () => {
		const html = buildBriefingDeck({ fontChars: 500_000 })
		const hint = readableWithHint(html, Buffer.byteLength(html))
		expect(hint).toMatch(/^get_file format=text \(\d+% of this file is embedded fonts\)$/)
	})

	it('stays quiet for a small file', () => {
		const html = buildBriefingDeck({ fontChars: 4000 })
		expect(readableWithHint(html, Buffer.byteLength(html))).toBeNull()
	})

	it('stays quiet for a large file that is mostly text', () => {
		const html = `<p>${'word '.repeat(40_000)}</p>`
		expect(readableWithHint(html, Buffer.byteLength(html))).toBeNull()
	})
})
