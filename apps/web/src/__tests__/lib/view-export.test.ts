import {
	BRIDGE_EXPORT_MESSAGE,
	BRIDGE_EXPORT_RESULT_MESSAGE,
	prepareBridgedViewHtml,
} from '@/lib/mini-app'
import {
	type ExportPage,
	buildPdf,
	exportFileName,
	htmlToMarkdown,
	pagesToMarkdown,
	parseExportPages,
	requestExportPages,
} from '@/lib/view-export'
import { afterEach, describe, expect, it, vi } from 'vitest'

const page = (xhtml: string): ExportPage => ({ xhtml, w: 100, h: 50, bg: '#fff' })

describe('htmlToMarkdown', () => {
	it('writes a table with a header rule', () => {
		const md = htmlToMarkdown(
			'<body><table><thead><tr><th>Deal</th><th>Value</th></tr></thead><tbody><tr><td>Acme</td><td>12</td></tr><tr><td>Beta | Co</td><td>7</td></tr></tbody></table></body>',
		)
		expect(md).toBe(
			['| Deal | Value |', '| --- | --- |', '| Acme | 12 |', '| Beta \\| Co | 7 |'].join('\n'),
		)
	})

	it('writes headings, lists (also nested and numbered), emphasis and links', () => {
		const md = htmlToMarkdown(
			'<body><h1>Week 46</h1><p>Plain <strong>bold</strong> and <em>soft</em>, see <a href="https://maskin.io/x">the page</a>.</p><ul><li>One<ul><li>Inner</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol></body>',
		)
		expect(md).toBe(
			[
				'# Week 46',
				'Plain **bold** and *soft*, see [the page](https://maskin.io/x).',
				'- One\n  - Inner\n- Two',
				'1. First\n2. Second',
			].join('\n\n'),
		)
	})

	it('drops scripts, styles and hidden elements, and keeps only web links', () => {
		const md = htmlToMarkdown(
			'<body><div style="display:none">secret</div><script>alert(1)</script><style>p{}</style><p>Shown <a href="javascript:alert(1)">click</a></p></body>',
		)
		expect(md).toBe('Shown click')
	})

	it('keeps text that sits straight in a div, one block per div', () => {
		expect(htmlToMarkdown('<body><div><div>A</div><div>B</div></div></body>')).toBe('A\n\nB')
	})
})

describe('pagesToMarkdown', () => {
	it('puts every slide in order, parted by a rule', () => {
		expect(
			pagesToMarkdown([page('<body><h1>One</h1></body>'), page('<body><h1>Two</h1></body>')]),
		).toBe('# One\n\n---\n\n# Two\n')
	})
})

describe('exportFileName', () => {
	it('names the file after the view and the date', () => {
		expect(exportFileName('Open deals', 'pdf', new Date('2026-11-17T09:00:00Z'))).toBe(
			'open-deals-2026-11-17.pdf',
		)
	})

	it('drops a .html ending and unsafe characters, and falls back to "view"', () => {
		const date = new Date('2026-11-17T09:00:00Z')
		expect(exportFileName('Q4/Plan: v2.html', 'md', date)).toBe('q4-plan-v2-2026-11-17.md')
		expect(exportFileName('///', 'png', date)).toBe('view-2026-11-17.png')
	})
})

describe('parseExportPages', () => {
	it('refuses anything that is not a list of pages with a sane size', () => {
		expect(() => parseExportPages(undefined)).toThrow()
		expect(() => parseExportPages([])).toThrow()
		expect(() => parseExportPages([{ xhtml: 'x', w: 0, h: 10, bg: '#fff' }])).toThrow()
		expect(() => parseExportPages([{ xhtml: 'x', w: 10, h: 99999, bg: '#fff' }])).toThrow()
		expect(() => parseExportPages([{ xhtml: 1, w: 10, h: 10, bg: '#fff' }])).toThrow()
		expect(parseExportPages([{ xhtml: 'x', w: 10, h: 10, bg: '#fff', extra: 1 }])).toEqual([
			{ xhtml: 'x', w: 10, h: 10, bg: '#fff' },
		])
	})
})

// jsdom's Blob has no arrayBuffer(), so read it the way a page would without it.
function readBytes(blob: Blob): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(reader.result as ArrayBuffer)
		reader.onerror = () => reject(reader.error)
		reader.readAsArrayBuffer(blob)
	})
}

describe('buildPdf', () => {
	it('writes one page per image with a valid cross-reference table', async () => {
		const blob = buildPdf([
			{ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), pw: 2, ph: 2, w: 75, h: 37.5 },
			{ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), pw: 2, ph: 2, w: 75, h: 37.5 },
		])
		expect(blob.type).toBe('application/pdf')
		const text = new TextDecoder('latin1').decode(await readBytes(blob))
		expect(text.startsWith('%PDF-1.4')).toBe(true)
		expect(text).toContain('/Count 2')
		expect(text.match(/\/Type \/Page /g)).toHaveLength(2)
		expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
		// Every xref entry points at "N 0 obj".
		const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1])
		expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref')
		const entries = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]))
		expect(entries).toHaveLength(8)
		entries.forEach((offset, i) => {
			expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true)
		})
	})
})

describe('requestExportPages', () => {
	afterEach(() => vi.useRealTimers())

	function answer(init: MessageEventInit) {
		window.dispatchEvent(new MessageEvent('message', init))
	}

	it('sends the request and resolves with the pages the frame answers', async () => {
		const frame = {}
		const post = vi.fn()
		const pending = requestExportPages(() => frame, post)
		const { id } = post.mock.calls[0][0]
		expect(post).toHaveBeenCalledWith({ type: BRIDGE_EXPORT_MESSAGE, id })
		answer({
			source: frame as MessageEventSource,
			data: { type: BRIDGE_EXPORT_RESULT_MESSAGE, id, pages: [page('<body>x</body>')] },
		})
		await expect(pending).resolves.toEqual([page('<body>x</body>')])
	})

	it('ignores an answer from another window or with another id', async () => {
		vi.useFakeTimers()
		const frame = {}
		const post = vi.fn()
		const pending = requestExportPages(() => frame, post)
		const rejected = expect(pending).rejects.toThrow('did not answer')
		const { id } = post.mock.calls[0][0]
		const data = { type: BRIDGE_EXPORT_RESULT_MESSAGE, id, pages: [page('<body>x</body>')] }
		answer({ source: {} as MessageEventSource, data })
		answer({ source: frame as MessageEventSource, data: { ...data, id: id + 1 } })
		await vi.advanceTimersByTimeAsync(16_000)
		await rejected
	})

	it('rejects when the frame says it could not read the view', async () => {
		const frame = {}
		const post = vi.fn()
		const pending = requestExportPages(() => frame, post)
		const { id } = post.mock.calls[0][0]
		answer({
			source: frame as MessageEventSource,
			data: { type: BRIDGE_EXPORT_RESULT_MESSAGE, id, error: 'The view could not be read.' },
		})
		await expect(pending).rejects.toThrow('could not be read')
	})
})

describe('the frame side of export', () => {
	// The responder is a script in the view document. Run it here, with this window standing in
	// for both the frame and the host (jsdom's parent.parent is the window itself).
	function runResponder(body: string): Promise<{ pages?: ExportPage[]; error?: string }> {
		const html = prepareBridgedViewHtml(
			`<!doctype html><html><head></head><body>${body}</body></html>`,
		)
		document.body.innerHTML = body
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
		const responder = scripts.find(
			(s) => s.includes(BRIDGE_EXPORT_RESULT_MESSAGE) && s.includes('XMLSerializer'),
		)
		expect(responder).toBeDefined()
		return new Promise((resolve) => {
			const onMessage = (e: MessageEvent) => {
				if (e.data?.type !== BRIDGE_EXPORT_RESULT_MESSAGE) return
				window.removeEventListener('message', onMessage)
				resolve(e.data)
			}
			window.addEventListener('message', onMessage)
			new Function(responder as string)()
			window.dispatchEvent(
				new MessageEvent('message', {
					source: window,
					data: { type: BRIDGE_EXPORT_MESSAGE, id: 7 },
				}),
			)
		})
	}

	it('answers one page with no scripts, no handlers and no frames, styles written on', async () => {
		const answer = await runResponder(
			'<h1 style="color: red" onclick="steal()">Title</h1><script>1</script><iframe src="https://x.test"></iframe><a href="javascript:steal()">go</a>',
		)
		expect(answer.error).toBeUndefined()
		expect(answer.pages).toHaveLength(1)
		const { xhtml } = (answer.pages as ExportPage[])[0]
		expect(xhtml).toContain('Title')
		expect(xhtml).not.toMatch(/<script|<iframe|onclick|javascript:/i)
		expect(xhtml).toMatch(/style="[^"]*color:/)
		expect(xhtml).toContain('http://www.w3.org/1999/xhtml')
	})

	it('answers one page per slide, each holding only its own slide', async () => {
		const answer = await runResponder(
			'<section class="slide">First</section><section class="slide">Second</section>',
		)
		const pages = answer.pages as ExportPage[]
		expect(pages).toHaveLength(2)
		expect(pages[0].xhtml).toContain('First')
		expect(pages[0].xhtml).not.toContain('Second')
		expect(pages[1].xhtml).toContain('Second')
		expect(pages[1].xhtml).not.toContain('First')
		// The deck is left as it was.
		const slides = [...document.querySelectorAll<HTMLElement>('section.slide')]
		expect(slides.map((s) => s.style.display)).toEqual(['', ''])
	})
})
