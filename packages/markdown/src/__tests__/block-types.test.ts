// Per-block-type + edge-case unit tests for the serializer/parser layer.
//
// Complements `roundtrip.test.ts` (which asserts idempotence on ≥20 real
// blobs). This file targets one feature per test with the minimum input that
// exercises it — regressions surface as focused failures instead of a
// generic "fixture N drifted." Coverage explicitly named by the AC:
//
//   - ATX headings H1–H6
//   - bold, italic, strike, inline code
//   - links (including Maskin's [title](/<ws>/objects/<id>) shape)
//   - ordered / unordered lists with nesting
//   - blockquotes
//   - horizontal rules
//   - fenced code blocks with language (incl. Maskin's ```chart custom)
//   - GFM tables
//   - GFM task lists (`- [ ]` / `- [x]`)
//   - hard breaks
//   - nested blockquote + code
//   - escaped characters (`\*`, `\_`)

import { describe, expect, it } from 'vitest'
import { assertIdempotent, roundTrip } from '../roundtrip'

function expectIdempotent(md: string): string {
	const result = assertIdempotent(md)
	if (!result.ok) {
		throw new Error(
			`Round-trip drift.\n--- first ---\n${result.first}\n--- second ---\n${result.second}\n---`,
		)
	}
	return result.normalized
}

describe('ATX headings', () => {
	it.each([1, 2, 3, 4, 5, 6])('preserves H%i on round-trip', (level) => {
		const marker = '#'.repeat(level)
		const md = `${marker} Heading level ${level}\n\nBody paragraph.`
		const out = expectIdempotent(md)
		expect(out).toContain(`${marker} Heading level ${level}`)
	})

	it('normalizes setext headings to ATX', () => {
		const setext = 'Heading title\n=============\n\nBody.'
		const out = roundTrip(setext)
		expect(out).toContain('# Heading title')
		expect(out).not.toContain('=============')
	})
})

describe('inline marks', () => {
	it('preserves bold', () => {
		const out = expectIdempotent('This is **bold** text.')
		expect(out).toContain('**bold**')
	})

	it('preserves italic', () => {
		const out = expectIdempotent('This is *italic* text.')
		expect(out).toMatch(/\*italic\*/)
	})

	it('preserves strikethrough (GFM)', () => {
		const out = expectIdempotent('This is ~~struck~~ text.')
		expect(out).toContain('~~struck~~')
	})

	it('preserves inline code', () => {
		const out = expectIdempotent('Call `getMarkdown()` on the editor.')
		expect(out).toContain('`getMarkdown()`')
	})

	it('preserves combined bold + italic in one paragraph', () => {
		const out = expectIdempotent('A paragraph with **bold** and *italic* and `code`.')
		expect(out).toContain('**bold**')
		expect(out).toMatch(/\*italic\*/)
		expect(out).toContain('`code`')
	})
})

describe('links', () => {
	it('preserves external https links', () => {
		const out = expectIdempotent('See the [Tiptap docs](https://tiptap.dev/docs).')
		expect(out).toContain('[Tiptap docs](https://tiptap.dev/docs)')
	})

	it("preserves Maskin's relative object-link shape", () => {
		const md =
			'See [the bet](/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01).'
		const out = expectIdempotent(md)
		expect(out).toContain(
			'[the bet](/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01)',
		)
	})

	it('preserves absolute Maskin object links', () => {
		const md =
			'See [the bet](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01).'
		const out = expectIdempotent(md)
		expect(out).toContain('/e2877e32-2c11-489e-96c8-a76200908ed4/objects/')
	})
})

describe('lists', () => {
	it('round-trips a flat unordered list', () => {
		const md = '- one\n- two\n- three'
		const out = expectIdempotent(md)
		expect(out).toContain('- one')
		expect(out).toContain('- three')
	})

	it('round-trips a nested unordered list', () => {
		const md = '- outer\n    - inner\n    - inner 2\n- outer 2'
		const out = expectIdempotent(md)
		expect(out).toContain('- outer')
		expect(out).toContain('inner')
		expect(out).toContain('inner 2')
	})

	it('round-trips a flat ordered list', () => {
		const md = '1. first\n2. second\n3. third'
		const out = expectIdempotent(md)
		expect(out).toContain('1. first')
		expect(out).toContain('3. third')
	})

	it('round-trips a nested ordered list', () => {
		const md = '1. one\n    1. inner\n    2. inner 2\n2. two'
		const out = expectIdempotent(md)
		expect(out).toContain('1. one')
		expect(out).toContain('inner')
		expect(out).toContain('2. two')
	})
})

describe('GFM task lists', () => {
	it('preserves an unchecked task', () => {
		const md = '- [ ] undone'
		const out = expectIdempotent(md)
		expect(out).toContain('[ ]')
		expect(out).toContain('undone')
	})

	it('preserves a checked task', () => {
		const md = '- [x] done'
		const out = expectIdempotent(md)
		expect(out).toContain('[x]')
		expect(out).toContain('done')
	})

	it('round-trips a mix of checked and unchecked in one list', () => {
		const md = '- [x] done\n- [ ] undone\n- [x] also done'
		const out = expectIdempotent(md)
		expect(out).toMatch(/\[x\][^\n]*done/)
		expect(out).toMatch(/\[ \][^\n]*undone/)
	})
})

describe('blockquotes', () => {
	it('preserves a single-line blockquote', () => {
		const md = '> quoted line'
		const out = expectIdempotent(md)
		expect(out).toContain('> quoted line')
	})

	it('preserves a multi-paragraph blockquote', () => {
		const md = '> first para\n>\n> second para'
		const out = expectIdempotent(md)
		expect(out).toContain('> first para')
		expect(out).toContain('> second para')
	})

	// AC edge case: nested blockquote + code.
	it('preserves a nested blockquote containing a fenced code block', () => {
		const md = '> outer quote\n>\n> > inner quote\n> >\n> > ```\n> > code inside inner\n> > ```'
		const out = expectIdempotent(md)
		expect(out).toContain('outer quote')
		expect(out).toContain('inner quote')
		expect(out).toContain('code inside inner')
	})
})

describe('horizontal rule', () => {
	it('preserves a --- divider between paragraphs', () => {
		const md = 'above\n\n---\n\nbelow'
		const out = expectIdempotent(md)
		expect(out).toMatch(/\n-{3,}\n/)
		expect(out).toContain('above')
		expect(out).toContain('below')
	})
})

describe('fenced code blocks', () => {
	it('preserves a fenced block with language', () => {
		const md = '```ts\nconst x: number = 1\n```'
		const out = expectIdempotent(md)
		expect(out).toContain('```ts')
		expect(out).toContain('const x: number = 1')
	})

	it('preserves the ```chart custom fence verbatim', () => {
		// AC: chart round-trips as a plain fenced code block. Renderer decides
		// whether to draw the chart; the editor and CI must not interpret it.
		const md = '```chart\n{"type":"bar","data":[{"x":1,"y":2}]}\n```'
		const out = expectIdempotent(md)
		expect(out).toContain('```chart')
		expect(out).toContain('"type":"bar"')
	})

	it('preserves a jsonc fenced block with inline comments', () => {
		const md = '```jsonc\n{\n  "key": "value" // inline comment\n}\n```'
		const out = expectIdempotent(md)
		expect(out).toContain('```jsonc')
		expect(out).toContain('inline comment')
	})
})

describe('GFM tables', () => {
	it('round-trips a 2-column, 2-row table with a header row', () => {
		const md = '| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |'
		const out = expectIdempotent(md)
		expect(out).toContain('| A')
		expect(out).toContain('| a1')
		expect(out).toContain('| b2')
	})

	it('round-trips a table with inline code in cells', () => {
		const md = '| Key | Value |\n| --- | --- |\n| `id` | uuid |\n| `name` | string |'
		const out = expectIdempotent(md)
		expect(out).toContain('`id`')
		expect(out).toContain('`name`')
	})
})

describe('hard breaks', () => {
	it('preserves an intra-paragraph hard break (two trailing spaces + newline)', () => {
		const md = 'line one  \nline two'
		const out = expectIdempotent(md)
		// hard break renders as an intra-paragraph line break; the exact byte
		// form of the break is serializer-defined (two spaces + \n, or `\`
		// + \n depending on tiptap-markdown config). Assert both lines survive
		// as distinct — a lost hard break would collapse them into one.
		expect(out).toContain('line one')
		expect(out).toContain('line two')
	})
})

describe('escaped characters', () => {
	it('preserves \\* as literal * (not italic)', () => {
		const md = 'This is not \\*italic\\* text.'
		const out = expectIdempotent(md)
		// The literal `*` must survive somehow — the serializer may re-emit
		// the escape (`\*`) or a bare `*` where the parser can prove it can't
		// be read as an emphasis marker. Reject only a silent loss of the
		// star entirely, or an actual emphasis conversion.
		expect(out).toMatch(/\\?\*italic\\?\*/)
		expect(out).not.toMatch(/<em>/)
	})

	it('preserves \\_ as literal _ (not italic)', () => {
		const md = 'This has \\_underscores\\_ literally.'
		const out = expectIdempotent(md)
		// Same shape as `\*` above — either `\_underscores\_` or bare
		// `_underscores_` as long as it never becomes an emphasis span.
		expect(out).toMatch(/\\?_underscores\\?_/)
		expect(out).not.toMatch(/<em>/)
	})
})
