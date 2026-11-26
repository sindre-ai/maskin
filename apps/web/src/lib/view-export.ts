import {
	BRIDGE_EXPORT_MESSAGE,
	BRIDGE_EXPORT_RESULT_MESSAGE,
	ISOLATION_LOAD_MESSAGE,
	prepareIsolatedViewHtml,
} from './mini-app'

// Export of a custom view as Markdown, PNG or PDF. The file is built in the browser from what
// the view's frame drew (see EXPORT_RESPONDER in mini-app.ts) and saved by the person's click.
// Nothing is sent anywhere. The frame's copy has no scripts, so drawing it as an image runs
// nothing, and the page never puts it in its own document.

export type ExportFormat = 'markdown' | 'pdf' | 'png'

/** One page of a view: the rendered body as XHTML with styles on every element, and its size. */
export interface ExportPage {
	xhtml: string
	w: number
	h: number
	bg: string
}

export const EXPORT_FAILED_MESSAGE = "The export didn't work, so nothing was downloaded. Try again."

const MAX_PAGES = 200
const MAX_SIDE = 16_000
const EXPORT_TIMEOUT_MS = 15_000
/** Pixel density of PNG and PDF pages; the canvas is lowered to stay under MAX_PIXELS. */
const SCALE = 2
const MAX_PIXELS = 36_000_000

/** Checks what a frame answered. Anything else is refused, not repaired. */
export function parseExportPages(data: unknown): ExportPage[] {
	if (!Array.isArray(data) || data.length === 0 || data.length > MAX_PAGES) {
		throw new Error('The view gave no pages.')
	}
	return data.map((raw) => {
		const page = raw as Partial<ExportPage> | null
		if (
			!page ||
			typeof page.xhtml !== 'string' ||
			typeof page.bg !== 'string' ||
			typeof page.w !== 'number' ||
			typeof page.h !== 'number' ||
			!(page.w > 0 && page.w <= MAX_SIDE) ||
			!(page.h > 0 && page.h <= MAX_SIDE)
		) {
			throw new Error('The view gave a page that could not be read.')
		}
		return { xhtml: page.xhtml, w: page.w, h: page.h, bg: page.bg }
	})
}

let requestId = 0

/**
 * Asks a view's frame for its pages. The answer is accepted only from `frame`, with the id we
 * sent. `post` must send to that same frame.
 */
export function requestExportPages(
	frame: () => unknown,
	post: (message: Record<string, unknown>) => void,
): Promise<ExportPage[]> {
	const id = ++requestId
	return new Promise((resolve, reject) => {
		const finish = (settle: () => void) => {
			clearTimeout(timer)
			window.removeEventListener('message', onMessage)
			settle()
		}
		function onMessage(event: MessageEvent) {
			const data = event.data as { type?: unknown; id?: unknown; pages?: unknown; error?: unknown }
			const source = frame()
			if (!source || event.source !== source) return
			if (!data || data.type !== BRIDGE_EXPORT_RESULT_MESSAGE || data.id !== id) return
			if (typeof data.error === 'string') {
				finish(() => reject(new Error(data.error as string)))
				return
			}
			try {
				const pages = parseExportPages(data.pages)
				finish(() => resolve(pages))
			} catch (err) {
				finish(() => reject(err))
			}
		}
		const timer = setTimeout(
			() => finish(() => reject(new Error('The view did not answer in time.'))),
			EXPORT_TIMEOUT_MS,
		)
		window.addEventListener('message', onMessage)
		post({ type: BRIDGE_EXPORT_MESSAGE, id })
	})
}

/**
 * Pages of a view that is not on screen as a live frame (a deck): the document runs once in a
 * hidden copy of the view frame, answers, and is removed.
 */
export function exportPagesOfDocument(html: string): Promise<ExportPage[]> {
	return new Promise((resolve, reject) => {
		const iframe = document.createElement('iframe')
		iframe.setAttribute('sandbox', 'allow-scripts')
		iframe.setAttribute('aria-hidden', 'true')
		iframe.tabIndex = -1
		iframe.style.cssText =
			'position:fixed;left:-10000px;top:0;width:1280px;height:720px;border:0;pointer-events:none'
		iframe.srcdoc = prepareIsolatedViewHtml(html)
		const cleanup = () => {
			window.removeEventListener('message', onLoad)
			iframe.remove()
		}
		function onLoad(event: MessageEvent) {
			if (
				event.source !== iframe.contentWindow ||
				(event.data as { type?: unknown } | null)?.type !== ISOLATION_LOAD_MESSAGE
			)
				return
			window.removeEventListener('message', onLoad)
			const inner = iframe.contentWindow?.frames[0] ?? null
			requestExportPages(
				() => inner,
				(message) => inner?.postMessage(message, '*'),
			).then(
				(pages) => {
					cleanup()
					resolve(pages)
				},
				(err) => {
					cleanup()
					reject(err)
				},
			)
		}
		window.addEventListener('message', onLoad)
		document.body.appendChild(iframe)
	})
}

// ---------------------------------------------------------------------------
// Markdown

const BLOCK_SKIP = new Set(['script', 'style', 'head', 'noscript', 'template'])

function isHidden(el: Element): boolean {
	const style = el.getAttribute('style') ?? ''
	return /(^|;)\s*display\s*:\s*none\s*(;|$)/i.test(style)
}

function inline(node: Node): string {
	if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
	if (node.nodeType !== 1) return ''
	const el = node as Element
	const tag = el.tagName.toLowerCase()
	if (BLOCK_SKIP.has(tag) || isHidden(el)) return ''
	const inner = () => Array.from(el.childNodes).map(inline).join('')
	switch (tag) {
		case 'br':
			return '  \n'
		case 'strong':
		case 'b': {
			const text = inner().trim()
			return text ? `**${text}**` : ''
		}
		case 'em':
		case 'i': {
			const text = inner().trim()
			return text ? `*${text}*` : ''
		}
		case 'code':
			return `\`${(el.textContent ?? '').replace(/`/g, "'")}\``
		case 'a': {
			const text = inner().trim()
			const href = el.getAttribute('href') ?? ''
			return text && /^(https?:|mailto:)/i.test(href) ? `[${text}](${href})` : text
		}
		case 'img': {
			const alt = el.getAttribute('alt')?.trim()
			return alt ? alt : ''
		}
		default:
			return inner()
	}
}

function cell(el: Element): string {
	return inline(el).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function table(el: Element): string {
	const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
		Array.from(tr.children)
			.filter((c) => /^(td|th)$/i.test(c.tagName))
			.map(cell),
	)
	const filled = rows.filter((r) => r.length > 0)
	if (filled.length === 0) return ''
	const width = Math.max(...filled.map((r) => r.length))
	const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
	const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
	return [line(filled[0]), line(Array(width).fill('---')), ...filled.slice(1).map(line)].join('\n')
}

function list(el: Element, depth: number): string {
	const ordered = el.tagName.toLowerCase() === 'ol'
	const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li')
	return items
		.map((li, i) => {
			const marker = ordered ? `${i + 1}.` : '-'
			const nested: string[] = []
			const own = Array.from(li.childNodes)
				.map((child) => {
					if (child.nodeType === 1 && /^(ul|ol)$/i.test((child as Element).tagName)) {
						nested.push(list(child as Element, depth + 1))
						return ''
					}
					return inline(child)
				})
				.join('')
				.replace(/\s+/g, ' ')
				.trim()
			const pad = '  '.repeat(depth)
			return [`${pad}${marker} ${own}`, ...nested].join('\n')
		})
		.join('\n')
}

function blocks(parent: Node, depth = 0): string[] {
	const out: string[] = []
	let run = ''
	const flush = () => {
		const text = run.replace(/[ \t]+\n/g, '\n').trim()
		if (text) out.push(text)
		run = ''
	}
	for (const node of Array.from(parent.childNodes)) {
		if (node.nodeType === 3) {
			run += (node.textContent ?? '').replace(/\s+/g, ' ')
			continue
		}
		if (node.nodeType !== 1) continue
		const el = node as Element
		const tag = el.tagName.toLowerCase()
		if (BLOCK_SKIP.has(tag) || isHidden(el)) continue
		if (/^h[1-6]$/.test(tag)) {
			flush()
			const text = inline(el).replace(/\s+/g, ' ').trim()
			if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
		} else if (tag === 'p') {
			flush()
			const text = inline(el).trim()
			if (text) out.push(text)
		} else if (tag === 'ul' || tag === 'ol') {
			flush()
			out.push(list(el, depth))
		} else if (tag === 'table') {
			flush()
			const md = table(el)
			if (md) out.push(md)
		} else if (tag === 'pre') {
			flush()
			out.push(`\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\``)
		} else if (tag === 'blockquote') {
			flush()
			const text = blocks(el, depth).join('\n\n')
			if (text) out.push(text.replace(/^/gm, '> '))
		} else if (tag === 'hr') {
			flush()
			out.push('---')
		} else if (
			/^(div|section|article|main|header|footer|aside|nav|body|figure|figcaption|details|summary|form|fieldset|dl|dt|dd|li|tbody|thead|tfoot|tr|td|th)$/.test(
				tag,
			)
		) {
			flush()
			out.push(...blocks(el, depth))
		} else {
			run += inline(el)
		}
	}
	flush()
	return out
}

/** The text of a page as Markdown: headings, paragraphs, lists, tables, code, links and emphasis. */
export function htmlToMarkdown(xhtml: string): string {
	const doc = new DOMParser().parseFromString(xhtml, 'text/html')
	return blocks(doc.body).join('\n\n')
}

/** Every page in order, one block per slide, parted by a rule. */
export function pagesToMarkdown(pages: ExportPage[]): string {
	return `${pages
		.map((p) => htmlToMarkdown(p.xhtml))
		.filter(Boolean)
		.join('\n\n---\n\n')}\n`
}

// ---------------------------------------------------------------------------
// PNG and PDF

function svgOf(page: ExportPage): string {
	const w = Math.ceil(page.w)
	const h = Math.ceil(page.h)
	const bg = page.bg.replace(/[^a-zA-Z0-9#(),.% -]/g, '')
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:${bg}">${page.xhtml}</div></foreignObject></svg>`
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error('The page could not be drawn.'))
		img.src = src
	})
}

/** Draws one page on a canvas. The page is an image with no scripts in it, so nothing runs. */
export async function renderPage(page: ExportPage, opaque: boolean): Promise<HTMLCanvasElement> {
	const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgOf(page))}`)
	const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / (page.w * page.h)))
	const canvas = document.createElement('canvas')
	canvas.width = Math.max(1, Math.floor(page.w * scale))
	canvas.height = Math.max(1, Math.floor(page.h * scale))
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('The page could not be drawn.')
	if (opaque) {
		ctx.fillStyle = '#ffffff'
		ctx.fillRect(0, 0, canvas.width, canvas.height)
	}
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
	return canvas
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) =>
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('The page could not be saved.'))),
			type,
			quality,
		),
	)
}

interface PdfImage {
	jpeg: Uint8Array
	/** Pixels of the JPEG. */
	pw: number
	ph: number
	/** Page size in points (1/72 inch), 96 pixels to the inch like the screen. */
	w: number
	h: number
}

/** A PDF with one full-page JPEG per page. Written by hand: the format needs no library for this. */
export function buildPdf(images: PdfImage[]): Blob {
	const enc = new TextEncoder()
	const parts: Uint8Array[] = []
	const offsets: number[] = []
	let length = 0
	const push = (chunk: Uint8Array | string) => {
		const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk
		parts.push(bytes)
		length += bytes.length
	}
	const object = (n: number, body: () => void) => {
		offsets[n] = length
		push(`${n} 0 obj\n`)
		body()
		push('\nendobj\n')
	}
	const n = images.length
	// 1 = catalog, 2 = page tree, then three objects per page: page, content, image.
	push('%PDF-1.4\n')
	object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'))
	object(2, () =>
		push(
			`<< /Type /Pages /Count ${n} /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`,
		),
	)
	images.forEach((img, i) => {
		const page = 3 + i * 3
		const w = Math.round(img.w * 100) / 100
		const h = Math.round(img.h * 100) / 100
		object(page, () =>
			push(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`,
			),
		)
		const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
		object(page + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
		object(page + 2, () => {
			push(
				`<< /Type /XObject /Subtype /Image /Width ${img.pw} /Height ${img.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
			)
			push(img.jpeg)
			push('\nendstream')
		})
	})
	const count = 3 + n * 3
	const xref = length
	push(`xref\n0 ${count}\n0000000000 65535 f \n`)
	for (let i = 1; i < count; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
	push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
	return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

// ---------------------------------------------------------------------------
// Files

/** "Open deals" and a date become "open-deals-2026-11-17.md". */
export function exportFileName(name: string, extension: string, date = new Date()): string {
	const base =
		name
			.replace(/\.html?$/i, '')
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '') || 'view'
	return `${base}-${date.toISOString().slice(0, 10)}.${extension}`
}

function save(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = fileName
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)
}

/**
 * Builds the file for `format` and saves it. Throws, and saves nothing, if any step fails.
 * `pageIndex` limits PNG to the page on screen; Markdown and PDF take every page.
 */
export async function exportPages(
	format: ExportFormat,
	pages: ExportPage[],
	name: string,
	pageIndex = 0,
): Promise<void> {
	if (format === 'markdown') {
		save(
			new Blob([pagesToMarkdown(pages)], { type: 'text/markdown;charset=utf-8' }),
			exportFileName(name, 'md'),
		)
		return
	}
	if (format === 'png') {
		const page = pages[Math.min(Math.max(pageIndex, 0), pages.length - 1)]
		const blob = await toBlob(await renderPage(page, false), 'image/png')
		save(blob, exportFileName(name, 'png'))
		return
	}
	const images: PdfImage[] = []
	for (const page of pages) {
		const canvas = await renderPage(page, true)
		const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer())
		images.push({
			jpeg,
			pw: canvas.width,
			ph: canvas.height,
			w: page.w * 0.75,
			h: page.h * 0.75,
		})
	}
	save(buildPdf(images), exportFileName(name, 'pdf'))
}
