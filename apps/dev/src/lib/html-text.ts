import { type DefaultTreeAdapterMap, type TreeAdapter, defaultTreeAdapter, parse } from 'parse5'

/**
 * Reads any agent-authored HTML file as text: a deck, a website, a dashboard, a
 * custom view. Such files are often mostly embedded base64 fonts and inline
 * CSS or script (about 95% of a 550 KB deck), so the raw bytes are unreadable to
 * a model; the words a human sees are a few kilobytes. This pulls those out as
 * markdown: headings, paragraphs, bullets, tables, links, control labels, and,
 * for a deck (`<section class="slide">`), one block per slide with the speaker
 * notes kept in `data-notes`.
 *
 * Pure function of the bytes, so callers can compute it on every read. Nothing
 * here is stored.
 */

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type TextNode = DefaultTreeAdapterMap['textNode']
type Template = DefaultTreeAdapterMap['template']

export interface HtmlText {
	/** Markdown. When the file carries a deck-source script, that source verbatim. */
	contentText: string
	title: string | null
	/** `<meta name="description">`, if any. */
	description: string | null
	/** Parsed `application/ld+json` blocks; unparseable ones come back as raw strings. */
	jsonLd: unknown[]
	/** True when `contentText` is the file's own embedded markdown source. */
	fromDeckSource: boolean
	/**
	 * Set when the page shows little or no text in its markup but carries script,
	 * so what a person sees is probably drawn by that script. The extract is then
	 * not what they see; read the raw file for the logic.
	 */
	note: string | null
}

/** Beyond this the parse is not worth its memory; callers fall back to a clear error. */
export const MAX_HTML_TEXT_INPUT_BYTES = 8 * 1024 * 1024
const MAX_JSON_LD_CHARS = 20_000

/**
 * Deeper than this is not a page a person wrote. parse5 grows with the square of
 * the depth (about 3 s at 20,000 levels) and the walk below is recursive, so a
 * small file of nested tags would otherwise block the API process. Enforced
 * inside the parse (see depthLimitedAdapter), so a refusal costs about as much
 * as parsing 1,000 levels.
 */
export const MAX_HTML_NESTING_DEPTH = 1_000

export class HtmlTooDeepError extends Error {
	constructor(readonly maxDepth: number = MAX_HTML_NESTING_DEPTH) {
		super(`HTML is nested more than ${maxDepth} levels deep`)
		this.name = 'HtmlTooDeepError'
	}
}

/**
 * Counts depth as the parser places each node, so a file cannot hide depth from
 * it: stray end tags, unclosed tags and the rest are all settled by the parser
 * itself. Aborts the parse as soon as a node lands past the cap. When the parser
 * moves a node that already has children (it does so to repair mis-nested
 * formatting tags), their depths are brought up to date too.
 */
function depthLimitedAdapter(max: number): TreeAdapter<DefaultTreeAdapterMap> {
	const depths = new WeakMap<object, number>()
	const place = (parent: Node, child: Node) => {
		const stack: Array<[Node, number]> = [[child, (depths.get(parent) ?? 0) + 1]]
		for (let next = stack.pop(); next; next = stack.pop()) {
			const [node, depth] = next
			if (depth > max) throw new HtmlTooDeepError(max)
			depths.set(node, depth)
			// A template's children hang off its content fragment, which sits at the template's own level.
			const content =
				isElement(node) && node.tagName === 'template' ? (node as Template).content : undefined
			if (content) stack.push([content, depth])
			for (const c of children(node)) {
				if (isElement(c) && depths.get(c) !== depth + 1) stack.push([c, depth + 1])
			}
		}
	}
	return {
		...defaultTreeAdapter,
		appendChild(parent, child) {
			place(parent, child)
			defaultTreeAdapter.appendChild(parent, child)
		},
		insertBefore(parent, child, reference) {
			place(parent, child)
			defaultTreeAdapter.insertBefore(parent, child, reference)
		},
	}
}

const SKIP_TAGS = new Set([
	'head',
	'style',
	'script',
	'noscript',
	'template',
	'svg',
	'canvas',
	'iframe',
	'object',
	'embed',
	'audio',
	'video',
	'link',
	'meta',
])

const BLOCK_TAGS = new Set([
	'address',
	'article',
	'aside',
	'blockquote',
	'body',
	'caption',
	'dd',
	'details',
	'div',
	'dl',
	'dt',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'form',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'hr',
	'li',
	'main',
	'nav',
	'ol',
	'p',
	'pre',
	'section',
	'summary',
	'table',
	'tbody',
	'td',
	'tfoot',
	'th',
	'thead',
	'tr',
	'ul',
])

function isElement(n: Node): n is Element {
	return 'tagName' in n
}

function isText(n: Node): n is TextNode {
	return n.nodeName === '#text'
}

function attr(el: Element, name: string): string | undefined {
	return el.attrs.find((a) => a.name === name)?.value
}

function children(n: Node): Node[] {
	return 'childNodes' in n ? (n.childNodes as Node[]) : []
}

function textOf(n: Node): string {
	if (isText(n)) return n.value
	return children(n).map(textOf).join('')
}

function findAll(n: Node, pred: (el: Element) => boolean, out: Element[] = []): Element[] {
	if (isElement(n) && pred(n)) out.push(n)
	for (const c of children(n)) findAll(c, pred, out)
	return out
}

function classes(el: Element): string[] {
	return (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean)
}

function isSkipped(el: Element): boolean {
	if (SKIP_TAGS.has(el.tagName)) return true
	if (attr(el, 'hidden') !== undefined) return true
	if (attr(el, 'aria-hidden') === 'true') return true
	return false
}

const collapse = (s: string) => s.replace(/\s+/g, ' ')

/**
 * Buttons on a deck are previous/next/fullscreen chrome, so they stay out of a
 * deck's text. On any other page a button, field or menu is part of what the
 * page does, so its label is kept.
 */
let keepControls = true

function controlText(el: Element): string | null {
	const tag = el.tagName
	if (!keepControls) return tag === 'button' || tag === 'select' || tag === 'option' ? '' : null
	if (tag === 'button') {
		const label = collapse(textOf(el)).trim() || attr(el, 'aria-label')?.trim()
		return label ? `[button: ${label}]` : ''
	}
	if (tag === 'select') {
		const options = findAll(el, (e) => e.tagName === 'option')
			.map((o) => collapse(textOf(o)).trim())
			.filter(Boolean)
		const label = attr(el, 'aria-label')?.trim()
		return `[select${label ? ` ${label}` : ''}: ${options.join(', ')}]`
	}
	if (tag === 'input') {
		const type = (attr(el, 'type') ?? 'text').toLowerCase()
		if (type === 'hidden') return ''
		const label =
			attr(el, 'aria-label')?.trim() ||
			attr(el, 'placeholder')?.trim() ||
			attr(el, 'title')?.trim() ||
			(type === 'submit' || type === 'button' ? attr(el, 'value')?.trim() : '') ||
			attr(el, 'name')?.trim()
		return `[${type === 'submit' || type === 'button' ? 'button' : `input ${type}`}${label ? `: ${label}` : ''}]`
	}
	if (tag === 'textarea') {
		const label = attr(el, 'aria-label')?.trim() || attr(el, 'placeholder')?.trim()
		return `[textarea${label ? `: ${label}` : ''}]`
	}
	return null
}

const CONTROL_TAGS = new Set(['button', 'select', 'input', 'textarea'])

/** Link target worth printing: http(s), mailto, tel and relative paths. Never data: or javascript:. */
function printableHref(href: string | undefined): string | null {
	if (!href) return null
	const h = href.trim()
	if (!h || h.startsWith('#')) return null
	if (/^(data|javascript|blob):/i.test(h)) return null
	return h
}

/** Text of an element's content flowing inline, with links and bold kept as markdown. */
function inlineText(n: Node): string {
	if (isText(n)) return collapse(n.value)
	if (!isElement(n)) return children(n).map(inlineText).join('')
	if (isSkipped(n)) return ''
	const tag = n.tagName
	if (CONTROL_TAGS.has(tag)) return controlText(n) ?? ''
	if (tag === 'br') return '\n'
	if (tag === 'img') {
		const alt = attr(n, 'alt')?.trim()
		return alt ? `[image: ${alt}]` : ''
	}
	const inner = children(n).map(inlineText).join('')
	if (BLOCK_TAGS.has(tag)) return ` ${inner.trim()} `
	if (tag === 'a') {
		const text = inner.trim()
		const href = printableHref(attr(n, 'href'))
		if (!text) return ''
		return href ? `[${text}](${href})` : text
	}
	if (tag === 'strong' || tag === 'b') {
		const text = inner.trim()
		if (!text) return inner
		return `${inner.startsWith(' ') ? ' ' : ''}**${text}**${inner.endsWith(' ') ? ' ' : ''}`
	}
	if (tag === 'code') {
		const text = inner.trim()
		return text ? `\`${text}\`` : inner
	}
	return inner
}

function tidyInline(s: string): string {
	return s
		.split('\n')
		.map((l) => l.replace(/ +/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
}

/** Non-blank element children, or null when the element also has its own text. */
function onlySpanChildren(el: Element): Element[] | null {
	const spans: Element[] = []
	for (const c of children(el)) {
		if (isText(c)) {
			if (c.value.trim()) return null
			continue
		}
		if (!isElement(c)) continue
		if (c.tagName !== 'span') return null
		spans.push(c)
	}
	return spans.length > 1 ? spans : null
}

class Writer {
	readonly lines: string[] = []
	private inline = ''
	private prefix = ''

	/** Marks that the next flushed text starts a list item or quote. */
	setPrefix(p: string) {
		this.flush()
		this.prefix = p
	}

	addInline(s: string) {
		this.inline += s
	}

	flush() {
		const text = tidyInline(this.inline)
		this.inline = ''
		if (!text) return
		const [first, ...rest] = text.split('\n')
		const pad = ' '.repeat(this.prefix.length)
		this.lines.push(`${this.prefix}${first}`)
		for (const r of rest) this.lines.push(`${pad}${r}`)
		this.prefix = ''
	}

	/** A line of its own, kept apart from the paragraphs around it. */
	block(line: string) {
		this.flush()
		if (line) this.lines.push(line)
	}

	blank() {
		this.flush()
		if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('')
	}

	resetPrefix() {
		this.prefix = ''
	}
}

function cellText(el: Element): string {
	return tidyInline(inlineText(el)).replace(/\n/g, ' ').replace(/\|/g, '\\|')
}

function renderTable(table: Element, w: Writer) {
	const rows = findAll(table, (e) => e.tagName === 'tr')
	const grid: string[][] = []
	let headerRows = 0
	for (const tr of rows) {
		const cells = children(tr).filter(
			(c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'),
		)
		if (cells.length === 0) continue
		grid.push(cells.map(cellText))
		const inHead = (tr.parentNode as Element | null)?.tagName === 'thead'
		if (grid.length === headerRows + 1 && (inHead || cells.every((c) => c.tagName === 'th'))) {
			headerRows++
		}
	}
	if (grid.length === 0) return
	const width = Math.max(...grid.map((r) => r.length))
	const fmt = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`
	w.blank()
	// Markdown tables need a header row; use an empty one when the source has none.
	const header: string[] = (headerRows > 0 ? grid[0] : undefined) ?? Array(width).fill('')
	w.block(fmt(header))
	w.block(`|${Array(width).fill(' --- ').join('|')}|`)
	for (const r of grid.slice(headerRows > 0 ? 1 : 0)) w.block(fmt(r))
	w.blank()
}

function isSlide(el: Element): boolean {
	return el.tagName === 'section' && classes(el).includes('slide')
}

function walk(node: Node, w: Writer, ctx: { listDepth: number; slide: number }) {
	if (isText(node)) {
		w.addInline(collapse(node.value))
		return
	}
	if (!isElement(node)) {
		for (const c of children(node)) walk(c, w, ctx)
		return
	}
	if (isSkipped(node)) return
	const tag = node.tagName

	if (!BLOCK_TAGS.has(tag)) {
		// Inline element met in flow: render it whole so links and bold survive.
		w.addInline(inlineText(node))
		return
	}

	if (tag === 'table') {
		renderTable(node, w)
		return
	}
	if (tag === 'hr') {
		w.blank()
		return
	}
	if (tag === 'pre') {
		w.blank()
		w.block('```')
		for (const l of textOf(node).replace(/\n+$/, '').split('\n')) w.lines.push(l)
		w.block('```')
		w.blank()
		return
	}
	if (/^h[1-6]$/.test(tag)) {
		const text = tidyInline(inlineText(node)).replace(/\n/g, ' ')
		w.blank()
		if (text) w.block(`${'#'.repeat(Number(tag[1]))} ${text}`)
		w.blank()
		return
	}

	const slide = isSlide(node)
	if (slide) {
		ctx.slide++
		w.blank()
		if (ctx.slide > 1) w.block('---')
		w.block(`Slide ${ctx.slide}`)
		w.blank()
	}

	if (tag === 'li') {
		w.setPrefix(`${'  '.repeat(Math.max(0, ctx.listDepth - 1))}- `)
	} else if (tag === 'blockquote') {
		w.setPrefix('> ')
	} else {
		w.blank()
	}

	const spans = tag === 'li' || tag === 'div' || tag === 'p' ? onlySpanChildren(node) : null
	if (spans) {
		// A row of sibling spans is a visual row (a table laid out with CSS grid);
		// without a separator their words run together.
		const cells = spans.map((s) => tidyInline(inlineText(s)).replace(/\n/g, ' ')).filter(Boolean)
		w.addInline(cells.join(' | '))
	} else {
		const isList = tag === 'ul' || tag === 'ol'
		if (isList) ctx.listDepth++
		for (const c of children(node)) {
			if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol') && tag === 'li') {
				w.flush()
			}
			walk(c, w, ctx)
		}
		if (isList) ctx.listDepth--
	}
	w.flush()
	w.resetPrefix()

	const notes = attr(node, 'data-notes')?.trim()
	if (notes) {
		w.blank()
		w.block(`Notes: ${collapse(notes)}`)
	}
	if (tag !== 'li') w.blank()
	if (slide) w.blank()
}

function findDeckSource(root: Node): string | null {
	const [script] = findAll(root, (e) => e.tagName === 'script' && attr(e, 'id') === 'deck-source')
	if (!script) return null
	const type = (attr(script, 'type') ?? '').toLowerCase()
	if (type !== 'text/markdown' && type !== 'text/x-markdown') return null
	const text = textOf(script).trim()
	return text || null
}

function parseJsonLd(root: Node): unknown[] {
	const out: unknown[] = []
	const scripts = findAll(
		root,
		(e) =>
			e.tagName === 'script' && (attr(e, 'type') ?? '').toLowerCase() === 'application/ld+json',
	)
	for (const s of scripts) {
		const raw = textOf(s).trim()
		if (!raw) continue
		if (raw.length > MAX_JSON_LD_CHARS) {
			out.push(`${raw.slice(0, MAX_JSON_LD_CHARS)} [truncated]`)
			continue
		}
		try {
			out.push(JSON.parse(raw))
		} catch {
			out.push(raw)
		}
	}
	return out
}

/** Fewer visible characters than this, with script on the page, reads as drawn by the script. */
const SCRIPT_RENDERED_MAX_TEXT_CHARS = 200
const SCRIPT_RENDERED_MIN_SCRIPT_CHARS = 500

const SCRIPT_RENDERED_NOTE =
	'This page shows little text in its markup and carries script, so what a person sees is likely drawn by that script. Read the raw file (get_file format=raw) for its logic and data.'

/** Executable script, not data blocks such as JSON-LD or a deck's markdown source. */
function scriptWeight(root: Node): number {
	let weight = 0
	for (const s of findAll(root, (e) => e.tagName === 'script')) {
		const type = (attr(s, 'type') ?? '').toLowerCase()
		if (type && !/javascript|module|babel|jsx|text\/typescript/.test(type)) continue
		weight += attr(s, 'src') ? SCRIPT_RENDERED_MIN_SCRIPT_CHARS : textOf(s).length
	}
	return weight
}

export function extractHtmlText(html: string): HtmlText {
	const doc = parse(html, { treeAdapter: depthLimitedAdapter(MAX_HTML_NESTING_DEPTH) }) as Node

	const titleEl = findAll(doc, (e) => e.tagName === 'title')[0]
	const title = titleEl ? collapse(textOf(titleEl)).trim() || null : null
	const descEl = findAll(
		doc,
		(e) => e.tagName === 'meta' && attr(e, 'name')?.toLowerCase() === 'description',
	)[0]
	const description = (descEl && attr(descEl, 'content')?.trim()) || null
	const jsonLd = parseJsonLd(doc)

	const source = findDeckSource(doc)
	if (source) {
		return { contentText: source, title, description, jsonLd, fromDeckSource: true, note: null }
	}

	keepControls = findAll(doc, isSlide).length === 0
	const w = new Writer()
	const body = findAll(doc, (e) => e.tagName === 'body')[0]
	walk(body ?? doc, w, { listDepth: 0, slide: 0 })
	w.flush()

	const contentText = w.lines
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	const scriptRendered =
		contentText.length < SCRIPT_RENDERED_MAX_TEXT_CHARS &&
		scriptWeight(doc) >= SCRIPT_RENDERED_MIN_SCRIPT_CHARS
	return {
		contentText,
		title,
		description,
		jsonLd,
		fromDeckSource: false,
		note: scriptRendered ? SCRIPT_RENDERED_NOTE : null,
	}
}

/** Raw reads above this size get a pointer to the text format. */
export const READABLE_WITH_MIN_BYTES = 100 * 1024

const DATA_URI_RE = /data:([a-z0-9.+/-]*);base64,[A-Za-z0-9+/=]{200,}/gi

/**
 * How much of the file is base64 `data:` payloads, and whether those are mostly
 * fonts. Used only for the hint on a raw read, so it is a regex scan, not a parse.
 */
export function embeddedDataShare(html: string): { share: number; label: string } {
	let total = 0
	let fonts = 0
	for (const m of html.matchAll(DATA_URI_RE)) {
		total += m[0].length
		if (/font/i.test(m[1] ?? '')) fonts += m[0].length
	}
	return {
		share: html.length === 0 ? 0 : total / html.length,
		label: total > 0 && fonts * 2 >= total ? 'embedded fonts' : 'embedded data',
	}
}

/**
 * Hint placed ahead of `content` on a raw HTML read, so a reader that stops
 * early or has its tool result truncated still sees how to get the readable
 * version. Null when the file is small or is not mostly embedded data.
 */
export function readableWithHint(html: string, sizeBytes: number): string | null {
	if (sizeBytes < READABLE_WITH_MIN_BYTES) return null
	const { share, label } = embeddedDataShare(html)
	if (share < 0.2) return null
	return `get_file format=text (${Math.round(share * 100)}% of this file is ${label})`
}
