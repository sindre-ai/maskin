import remarkParse from 'remark-parse'
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify'
import { unified } from 'unified'
import { remarkPlugins } from './plugins'

// Owned Markdown serializer for the object editor write path (bet:
// tiptap-editor). Aligned with the read pipeline in `render.ts` so both sides
// speak the same dialect (ADR-1). Every option below is set explicitly — we
// don't lean on `remark-stringify`'s bundled defaults, because normalisation
// churn on untouched blocks is the round-trip killer we're trying to avoid.
//
// The choices below define Maskin's canonical Markdown shape. Fixtures under
// `__fixtures__/round-trip/` are written in this shape so the CI job asserts
// byte-exact `serialize(parse(source)) === source`. Non-canonical shapes
// (indented code, setext headings, two-space hard breaks) are covered by the
// canonicalisation fixtures and normalise deterministically on the first pass.
export const canonicalStringifyOptions: Readonly<StringifyOptions> = Object.freeze({
	bullet: '-', // unordered list marker — matches agent-authored corpus
	bulletOther: '*', // nested unordered marker; must differ from `bullet`
	bulletOrdered: '.', // `1.` not `1)` for ordered lists
	closeAtx: false, // `# Heading` not `# Heading #`
	emphasis: '*', // `*em*` for italics
	fence: '`', // triple-backtick fences (never tildes)
	fences: true, // always fence code blocks — indented code normalises up
	incrementListMarker: true, // `1. 2. 3.` not `1. 1. 1.`
	listItemIndent: 'one', // one-space indent after marker
	quote: '"', // link title quote style
	resourceLink: true, // `[text](url)` form, never autolinks for real links
	rule: '-', // `---` thematic break
	ruleRepetition: 3, // three chars for thematic breaks
	ruleSpaces: false, // `---` not `- - -`
	setext: false, // atx headings only; setext normalises up
	strong: '*', // `**strong**`
	tightDefinitions: false, // definitions separated by blank lines
})

const processor = unified()
	.use(remarkParse)
	.use(remarkPlugins as unknown as never[])
	.use(remarkStringify, canonicalStringifyOptions)

// Parse Markdown source and emit it back in Maskin's canonical shape. On
// input that already matches canonical shape, the output is byte-exact
// identical (the zero-diff invariant the round-trip corpus proves).
export function serializeMarkdown(source: string): string {
	const file = processor.processSync(source)
	return String(file)
}
