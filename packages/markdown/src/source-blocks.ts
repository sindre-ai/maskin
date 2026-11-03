// Save only the blocks a person touched.
//
// The editor re-serialises the whole document, which rewrites bytes the person
// never touched (and drops constructs it cannot hold). Markdown files are
// agent-written, so a human edit must not do that. This module keeps the
// original text, splits it into top-level blocks with exact character ranges,
// and on save writes the editor's text only for blocks that changed. Every
// other block, the blank lines between blocks and the final newline come back
// byte for byte (tech spec "save rules").
//
// Pure functions, no Tiptap or React: the editor wiring lives in
// `./react/editor.tsx` and `./editor-blocks.ts`. The markdown parser is the one
// the editor already uses (markdown-it, reached through tiptap-markdown), so
// the block boundaries line up with the editor's top-level nodes.

/** The slice of a markdown-it token this module reads. */
export interface MarkdownItToken {
	type: string
	tag: string
	level: number
	nesting: number
	map: [number, number] | null
	content: string
	info: string
	attrs: Array<[string, string]> | null
	children: MarkdownItToken[] | null
}

/** The slice of a markdown-it instance this module uses. */
export interface MarkdownItLike {
	parse(src: string, env: Record<string, unknown>): MarkdownItToken[]
}

export type ReadOnlyCause =
	| 'front_matter'
	| 'raw_html'
	| 'footnote'
	| 'link_reference'
	| 'block_mismatch'

/** What an edited block lost, named for the loss_check event. */
export type LossConstruct =
	| 'link_title'
	| 'link_target'
	| 'image'
	| 'heading_level'
	| 'code'
	| 'task_state'
	| 'text'

export interface SourceBlock {
	index: number
	/** Block text exactly as in the original, without the line break after it. */
	text: string
	/** Character offset of the first character of the block in the original. */
	start: number
	/** Character offset after the last character of the block (before its line break). */
	end: number
}

export interface SourceModel {
	original: string
	/** The file's own line break, used for new blocks. */
	eol: '\n' | '\r\n'
	/** Text before the first block (normally empty). */
	lead: string
	/** Text after the last block (normally the final newline). */
	trail: string
	blocks: SourceBlock[]
	/** gaps[i] is the original text between block i and block i + 1. */
	gaps: string[]
}

const LINE_BREAK = /\r\n|\r|\n/g

interface LineRange {
	start: number
	end: number
}

function lineRanges(text: string): LineRange[] {
	const lines: LineRange[] = []
	let start = 0
	LINE_BREAK.lastIndex = 0
	for (let m = LINE_BREAK.exec(text); m !== null; m = LINE_BREAK.exec(text)) {
		lines.push({ start, end: m.index })
		start = m.index + m[0].length
	}
	lines.push({ start, end: text.length })
	return lines
}

/** Top-level block tokens: level 0 and either opening or self-contained. */
function topLevelBlockTokens(tokens: MarkdownItToken[]): MarkdownItToken[] {
	return tokens.filter((t) => t.level === 0 && t.map !== null && t.nesting >= 0)
}

export function countSourceBlocks(md: MarkdownItLike, original: string): number {
	return topLevelBlockTokens(md.parse(original, {})).length
}

export function splitSource(md: MarkdownItLike, original: string): SourceModel {
	const lines = lineRanges(original)
	const lineAt = (i: number): LineRange =>
		lines[Math.min(Math.max(i, 0), lines.length - 1)] ?? { start: 0, end: original.length }
	const blocks: SourceBlock[] = []
	for (const token of topLevelBlockTokens(md.parse(original, {}))) {
		const map = token.map as [number, number]
		const first = Math.min(map[0], lines.length - 1)
		let last = Math.min(map[1], lines.length) - 1
		while (last > first && original.slice(lineAt(last).start, lineAt(last).end).trim() === '') {
			last--
		}
		const start = lineAt(first).start
		const end = lineAt(last).end
		blocks.push({ index: blocks.length, text: original.slice(start, end), start, end })
	}
	const gaps: string[] = []
	for (let i = 0; i + 1 < blocks.length; i++) {
		gaps.push(original.slice(blocks[i]?.end, blocks[i + 1]?.start))
	}
	const first = blocks[0]
	const last = blocks[blocks.length - 1]
	return {
		original,
		eol: original.includes('\r\n') ? '\r\n' : '\n',
		lead: first ? original.slice(0, first.start) : original,
		trail: last ? original.slice(last.end) : '',
		blocks,
		gaps,
	}
}

// ---------------------------------------------------------------------------
// Read-only list
// ---------------------------------------------------------------------------

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n(?![ \t]*\r?\n)[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FOOTNOTE_MARKER = /\[\^[^\]\s]+\]/

// Names on the HTML element list (current and obsolete, lower case). Only these
// count as raw HTML. A word in angle brackets that is not on the list, such as
// <owner>, <id> or a hyphenated <agent-id>, is a placeholder: the editor holds
// it as plain text. Names that are both an element and a likely placeholder
// (title, data, label, summary, source) stay on the list, so they open read-only.
const HTML_ELEMENTS = new Set(
	`a abbr acronym address applet area article aside audio b base basefont bdi bdo big
blockquote body br button canvas caption center cite code col colgroup data datalist dd del
details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame
frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li
link main map mark marquee math menu meta meter nav nobr noframes noscript object ol optgroup
option output p param picture pre progress q rp rt ruby s samp script search section select slot
small source span strike strong style sub summary sup svg table tbody td template textarea tfoot
th thead time title tr track tt u ul var video wbr`.split(/\s+/),
)

const HTML_TAG_NAME = /<\/?([A-Za-z][A-Za-z0-9-]*)/g

/** True when the text holds a comment, a declaration or a tag that is on the HTML element list. */
function holdsRealHtml(content: string): boolean {
	if (/<[!?]/.test(content)) return true
	for (const match of content.matchAll(HTML_TAG_NAME)) {
		if (HTML_ELEMENTS.has((match[1] ?? '').toLowerCase())) return true
	}
	return false
}

// markdown-it is built with html: false in the editor, so raw HTML is not a
// token there. Detection needs an instance with html on; it is built from the
// editor's own constructor so the version and dialect match.
const htmlParsers = new WeakMap<object, MarkdownItLike>()

function htmlEnabledParser(md: MarkdownItLike): MarkdownItLike {
	let parser = htmlParsers.get(md)
	if (!parser) {
		const MarkdownIt = (md as unknown as { constructor: new (o: object) => MarkdownItLike })
			.constructor
		parser = new MarkdownIt({ html: true })
		htmlParsers.set(md, parser)
	}
	return parser
}

/**
 * Why this text must open read-only, or null if it can be edited. Whole file,
 * never half. The block-count check needs the editor, so the caller passes
 * the count the editor ended up with.
 */
export function findReadOnlyCause(
	md: MarkdownItLike,
	original: string,
	editorBlockCount: number,
): ReadOnlyCause | null {
	// An empty file has nothing to protect; the editor opens it on one empty paragraph.
	if (original.trim() === '') return null
	if (FRONT_MATTER.test(original)) return 'front_matter'

	const env: { references?: Record<string, unknown> } = {}
	const tokens = htmlEnabledParser(md).parse(original, env)

	let footnote = false
	for (const token of tokens) {
		if (token.type === 'html_block' && holdsRealHtml(token.content)) return 'raw_html'
		for (const child of token.children ?? []) {
			if (child.type === 'html_inline' && holdsRealHtml(child.content)) return 'raw_html'
			if (child.type === 'text' && FOOTNOTE_MARKER.test(child.content)) footnote = true
		}
	}
	const references = Object.keys(env.references ?? {})
	// markdown-it reads "[^1]: note" as a link reference definition, so a
	// footnote definition shows up there under a label that starts with ^.
	if (footnote || references.some((label) => label.startsWith('^'))) return 'footnote'
	if (references.length > 0) return 'link_reference'

	if (countSourceBlocks(md, original) !== editorBlockCount) return 'block_mismatch'
	return null
}

// ---------------------------------------------------------------------------
// Loss check
// ---------------------------------------------------------------------------

export interface BlockFeatures {
	/** Visible text with all whitespace removed. */
	text: string
	linkTargets: string[]
	linkTitles: string[]
	/** src, alt and title of each image. */
	images: string[]
	headingLevels: number[]
	/** Language and text of each code block. */
	code: string[]
	/** x or space for each task item. */
	tasks: string[]
}

export function emptyFeatures(): BlockFeatures {
	return {
		text: '',
		linkTargets: [],
		linkTitles: [],
		images: [],
		headingLevels: [],
		code: [],
		tasks: [],
	}
}

export function normalizeText(text: string): string {
	return text.replace(/\s+/g, '')
}

function attr(token: MarkdownItToken, name: string): string {
	return token.attrs?.find(([key]) => key === name)?.[1] ?? ''
}

/** What a block says, read from markdown with the editor's own parser. */
export function blockFeatures(md: MarkdownItLike, markdown: string): BlockFeatures {
	const features = emptyFeatures()
	let text = ''
	for (const token of md.parse(markdown, {})) {
		if (token.type === 'heading_open') features.headingLevels.push(Number(token.tag.slice(1)))
		if (token.type === 'fence') {
			const lang = token.info.trim().split(/\s+/)[0] ?? ''
			features.code.push(`${lang}\u0000${token.content.replace(/\n$/, '')}`)
			text += token.content
		}
		if (token.type === 'code_block') {
			features.code.push(`\u0000${token.content.replace(/\n$/, '')}`)
			text += token.content
		}
		for (const child of token.children ?? []) {
			if (child.type === 'text' || child.type === 'code_inline') text += child.content
			else if (child.type === 'softbreak' || child.type === 'hardbreak') text += ' '
			else if (child.type === 'link_open') {
				features.linkTargets.push(attr(child, 'href'))
				features.linkTitles.push(attr(child, 'title'))
			} else if (child.type === 'image') {
				features.images.push(
					`${attr(child, 'src')}\u0000${child.content}\u0000${attr(child, 'title')}`,
				)
			} else if (
				child.type === 'html_inline' &&
				child.content.includes('task-list-item-checkbox')
			) {
				features.tasks.push(/\bchecked\b/.test(child.content) ? 'x' : ' ')
			}
		}
	}
	features.text = normalizeText(text)
	return features
}

const COMPARED: Array<[keyof BlockFeatures, LossConstruct]> = [
	['linkTitles', 'link_title'],
	['linkTargets', 'link_target'],
	['images', 'image'],
	['headingLevels', 'heading_level'],
	['code', 'code'],
	['tasks', 'task_state'],
	['text', 'text'],
]

/** The first construct that differs between two feature sets, or null. */
export function firstDifference(a: BlockFeatures, b: BlockFeatures): LossConstruct | null {
	for (const [key, construct] of COMPARED) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return construct
	}
	return null
}

// ---------------------------------------------------------------------------
// Aligning the editor's blocks with the blocks it loaded
// ---------------------------------------------------------------------------

type Segment =
	| { kind: 'same'; baseline: number; current: number }
	| { kind: 'changed'; baseline: [number, number]; current: [number, number] }

/** Longest common subsequence of two string lists, as matched index pairs. */
function matchBlocks(baseline: string[], current: string[]): Array<[number, number]> {
	let prefix = 0
	while (
		prefix < baseline.length &&
		prefix < current.length &&
		baseline[prefix] === current[prefix]
	) {
		prefix++
	}
	let suffix = 0
	while (
		suffix < baseline.length - prefix &&
		suffix < current.length - prefix &&
		baseline[baseline.length - 1 - suffix] === current[current.length - 1 - suffix]
	) {
		suffix++
	}

	const a = baseline.slice(prefix, baseline.length - suffix)
	const b = current.slice(prefix, current.length - suffix)
	// lcs[i * width + j] is the longest common subsequence of a[i..] and b[j..].
	const width = b.length + 1
	const lcs = new Array<number>((a.length + 1) * width).fill(0)
	const at = (i: number, j: number) => lcs[i * width + j] ?? 0
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i * width + j] =
				a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
		}
	}

	const pairs: Array<[number, number]> = []
	for (let i = 0; i < prefix; i++) pairs.push([i, i])
	let i = 0
	let j = 0
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			pairs.push([prefix + i, prefix + j])
			i++
			j++
		} else if (at(i + 1, j) >= at(i, j + 1)) i++
		else j++
	}
	for (let k = suffix; k > 0; k--) pairs.push([baseline.length - k, current.length - k])
	return pairs
}

function segmentBlocks(baseline: string[], current: string[]): Segment[] {
	const segments: Segment[] = []
	let b = 0
	let c = 0
	const flush = (nextB: number, nextC: number) => {
		if (nextB - b === nextC - c) {
			// Same number of blocks on both sides: each one was edited in place, so
			// a refusal for one must not hold back its neighbour.
			for (let k = 0; k < nextB - b; k++) {
				segments.push({
					kind: 'changed',
					baseline: [b + k, b + k + 1],
					current: [c + k, c + k + 1],
				})
			}
		} else {
			segments.push({ kind: 'changed', baseline: [b, nextB], current: [c, nextC] })
		}
	}
	for (const [mb, mc] of matchBlocks(baseline, current)) {
		flush(mb, mc)
		segments.push({ kind: 'same', baseline: mb, current: mc })
		b = mb + 1
		c = mc + 1
	}
	flush(baseline.length, current.length)
	return segments
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export interface SourceSession {
	md: MarkdownItLike
	model: SourceModel
	/** The editor's text for each top-level block of the untouched document. */
	baseline: string[]
}

export function createSourceSession(
	md: MarkdownItLike,
	original: string,
	baseline: string[],
): SourceSession {
	return { md, model: splitSource(md, original), baseline }
}

export interface RefusedRewrite {
	construct: LossConstruct
	/** Indexes of the original blocks that were kept as they were. */
	blocks: number[]
}

export interface SaveResult {
	/** The text to store. Equal to the original when nothing needs saving. */
	text: string
	refused: RefusedRewrite[]
}

export interface SaveInput {
	/** The editor's text for each top-level block of the document now. */
	current: string[]
	/** What the editor holds for block j now: used to check the rewrite lost nothing. */
	currentFeatures?: (index: number) => BlockFeatures
}

interface OutputItem {
	text: string
	firstOrig: number | null
	lastOrig: number | null
}

/**
 * Build the text to store: untouched blocks come back as loaded, touched blocks
 * come from the editor, unless the editor cannot hold something in the block
 * (loss check), in which case the original lines are kept for that run.
 */
export function buildSave(session: SourceSession, input: SaveInput): SaveResult {
	const { model, baseline } = session
	const { current } = input
	const segments = segmentBlocks(baseline, current)
	if (segments.every((s) => s.kind === 'same')) return { text: model.original, refused: [] }

	const newline = (text: string) => (model.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text)
	const items: OutputItem[] = []
	const refused: RefusedRewrite[] = []

	for (const segment of segments) {
		if (segment.kind === 'same') {
			const block = model.blocks[segment.baseline]
			if (block) items.push({ text: block.text, firstOrig: block.index, lastOrig: block.index })
			continue
		}

		const [bFrom, bTo] = segment.baseline
		const [cFrom, cTo] = segment.current
		const construct = rewriteLoss(session, input, [bFrom, bTo], [cFrom, cTo])
		if (construct) {
			const kept: number[] = []
			for (let i = bFrom; i < bTo; i++) {
				const block = model.blocks[i]
				if (!block) continue
				items.push({ text: block.text, firstOrig: block.index, lastOrig: block.index })
				kept.push(i)
			}
			refused.push({ construct, blocks: kept })
			continue
		}

		for (let j = cFrom; j < cTo; j++) {
			items.push({
				text: newline(current[j] ?? ''),
				firstOrig: j === cFrom && bTo > bFrom ? bFrom : null,
				lastOrig: j === cTo - 1 && bTo > bFrom ? bTo - 1 : null,
			})
		}
	}

	if (items.length === 0) return { text: '', refused }

	const blank = model.eol + model.eol
	let out = model.lead
	let previous: OutputItem | undefined
	for (const item of items) {
		if (previous) out += separator(model, previous, item, blank)
		out += item.text
		previous = item
	}
	out += model.trail || (model.blocks.length === 0 ? model.eol : '')
	return { text: out, refused }
}

function separator(model: SourceModel, prev: OutputItem, next: OutputItem, blank: string): string {
	if (prev.lastOrig !== null && prev.lastOrig < model.blocks.length - 1) {
		return model.gaps[prev.lastOrig] ?? blank
	}
	if (next.firstOrig !== null && next.firstOrig > 0) {
		return model.gaps[next.firstOrig - 1] ?? blank
	}
	return blank
}

/** Why a changed run of blocks must not be rewritten, or null if it may be. */
function rewriteLoss(
	session: SourceSession,
	input: SaveInput,
	baselineRange: [number, number],
	currentRange: [number, number],
): LossConstruct | null {
	const { md, model, baseline } = session

	// The editor cannot hold something that was in the original block, so any
	// rewrite of it would lose that thing whatever the person typed.
	for (let i = baselineRange[0]; i < baselineRange[1]; i++) {
		const difference = firstDifference(
			blockFeatures(md, model.blocks[i]?.text ?? ''),
			blockFeatures(md, baseline[i] ?? ''),
		)
		if (difference) return difference
	}

	// What the person has in the editor must survive being written as markdown.
	if (input.currentFeatures) {
		for (let j = currentRange[0]; j < currentRange[1]; j++) {
			const difference = firstDifference(
				input.currentFeatures(j),
				blockFeatures(md, input.current[j] ?? ''),
			)
			if (difference) return difference
		}
	}
	return null
}
