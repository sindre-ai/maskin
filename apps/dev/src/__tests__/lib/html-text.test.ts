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

describe('extractHtmlText on pages that are not decks', () => {
	const website = `<!doctype html><html><head><title>Acme pricing</title>
		<style>body{font-family:x}</style>
		<script>window.dataLayer=[];</script></head>
		<body><header><nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav></header>
		<main><h1>Simple pricing</h1><p>Start free, then pay <strong>$12</strong> per seat.</p>
		<ul><li>Unlimited chats</li><li>Agents that run on their own</li></ul>
		<img src="data:image/png;base64,AAAA" alt="Product screenshot">
		<a class="cta" href="/signup">Start free</a></main>
		<footer>Acme Inc, Oslo</footer></body></html>`

	const dashboard = `<!doctype html><html><head><title>Pipeline</title></head><body>
		<h1>Pipeline</h1>
		<label>Status</label>
		<select aria-label="Status"><option>Open</option><option>Done</option></select>
		<input type="text" placeholder="Search deals">
		<input type="hidden" name="csrf" value="x">
		<textarea placeholder="Add a note"></textarea>
		<button>Export CSV</button>
		<button aria-label="Refresh"><svg></svg></button>
		<div class="grid"><span>Acme</span><span>$12k</span><span>Won</span></div>
		</body></html>`

	const scriptView = `<!doctype html><html><head><title>Live view</title></head>
		<body><div id="root"></div>
		<script>${'const render = () => { document.getElementById("root").innerHTML = "x" };'.repeat(20)}</script>
		</body></html>`

	it('reads a website as headings, paragraphs, lists, links and image alt text', () => {
		const r = extractHtmlText(website)
		expect(r.title).toBe('Acme pricing')
		expect(r.contentText).toContain('# Simple pricing')
		expect(r.contentText).toContain('**$12**')
		expect(r.contentText).toContain('- Unlimited chats')
		expect(r.contentText).toContain('[image: Product screenshot]')
		expect(r.contentText).toContain('[Start free](/signup)')
		expect(r.contentText).not.toContain('dataLayer')
		expect(r.contentText).not.toContain('Slide')
		expect(r.note).toBeNull()
	})

	it('keeps button, field and menu labels on a page that is not a deck', () => {
		const r = extractHtmlText(dashboard)
		expect(r.contentText).toContain('[button: Export CSV]')
		expect(r.contentText).toContain('[button: Refresh]')
		expect(r.contentText).toContain('[select Status: Open, Done]')
		expect(r.contentText).toContain('[input text: Search deals]')
		expect(r.contentText).toContain('[textarea: Add a note]')
		expect(r.contentText).not.toContain('csrf')
		expect(r.contentText).toContain('Acme | $12k | Won')
	})

	it('leaves a deck’s navigation buttons out', () => {
		const r = extractHtmlText(
			'<body><button>Previous</button><section class="slide"><h2>One</h2></section><button>Next</button></body>',
		)
		expect(r.contentText).toContain('## One')
		expect(r.contentText).not.toContain('Previous')
		expect(r.contentText).not.toContain('Next')
	})

	it('says so when a page is drawn by script and shows almost no text', () => {
		const r = extractHtmlText(scriptView)
		expect(r.note).toMatch(/drawn by that script/)
		expect(r.note).toMatch(/format=raw/)
	})

	it('does not flag a page with real text, or one whose only script is data', () => {
		const withText = extractHtmlText(
			`<body><p>${'Words a person reads. '.repeat(20)}</p><script>${'a=1;'.repeat(300)}</script></body>`,
		)
		expect(withText.note).toBeNull()
		const dataOnly = extractHtmlText(
			`<body><script type="application/ld+json">${JSON.stringify({ a: 'x'.repeat(900) })}</script></body>`,
		)
		expect(dataOnly.note).toBeNull()
	})
})
