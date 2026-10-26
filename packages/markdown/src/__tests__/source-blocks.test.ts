// The touched-blocks save, run through the app's real editor setup.
//
// Every fixture in ./fixtures is a verbatim copy of a live object. The contract
// (tech spec "save rules"): opening and not editing writes nothing, changing
// one word changes only the block holding that word, and everything else comes
// back byte for byte.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changedLines, openSource } from './open-source'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures')
const fixtureFiles = readdirSync(FIXTURES_DIR)
	.filter((f) => f.endsWith('.md'))
	.sort()

function firstWord(markdown: string): string {
	const opened = openSource(markdown)
	let word = ''
	opened.editor.state.doc.descendants((node) => {
		if (word || !node.isText || !node.text) return
		word = node.text.match(/[A-Za-z]{5,}/)?.[0] ?? ''
	})
	opened.destroy()
	return word
}

describe('open and do not edit', () => {
	it.each(fixtureFiles)('saves nothing for %s', (file) => {
		const original = readFileSync(join(FIXTURES_DIR, file), 'utf8')
		const opened = openSource(original)
		expect(opened.cause).toBeNull()
		const result = opened.save()
		expect(result.text).toBe(original)
		expect(result.refused).toEqual([])
		opened.destroy()
	})
})

describe('change one word', () => {
	it.each(fixtureFiles)('changes only the line holding the word in %s', (file) => {
		const original = readFileSync(join(FIXTURES_DIR, file), 'utf8')
		const word = firstWord(original)
		expect(word).not.toBe('')
		const opened = openSource(original)
		opened.replace(word, `${word}X`)
		const result = opened.save()
		expect(result.refused).toEqual([])
		const diff = changedLines(original, result.text)
		expect(diff).toHaveLength(1)
		expect(diff[0]).toContain(`${word}X`)
		opened.destroy()
	})

	it('writes the original bytes back when a change is undone', () => {
		const original = 'alpha beta\n\ngamma\n'
		const opened = openSource(original)
		opened.replace('beta', 'betaX')
		opened.replace('betaX', 'beta')
		expect(opened.save().text).toBe(original)
		opened.destroy()
	})

	it.each([
		['a heading', '#### Four\n\n# One\n\nbody here\n', 'Four', 'Fourth', '#### Fourth'],
		['a quote', '> quoted text\n\nafter\n', 'quoted', 'QUOTED', '> QUOTED text'],
		['a list item', '- one\n- two\n\nafter\n', 'two', 'twoo', '- twoo'],
		['a code block', '```ts\nconst a = 1\n```\n\nafter\n', 'const a', 'const bb', 'const bb = 1'],
	])('touches only %s', (_name, original, from, to, expectedLine) => {
		const opened = openSource(original)
		opened.replace(from, to)
		const result = opened.save()
		expect(changedLines(original, result.text)).toHaveLength(1)
		expect(result.text).toContain(expectedLine)
		opened.destroy()
	})
})

describe('untouched blocks stay as written', () => {
	const original = [
		'#### Level four heading',
		'',
		'Setext heading',
		'--------------',
		'',
		'* star one',
		'* star two',
		'',
		'***',
		'',
		'3) third',
		'4) fourth',
		'',
		'Edit me here',
		'',
	].join('\n')

	it('keeps star bullets, setext headings, dividers and numbering that were not touched', () => {
		const opened = openSource(original)
		opened.replace('Edit me', 'Edited')
		const result = opened.save()
		expect(changedLines(original, result.text)).toEqual(['Edit me here -> Edited here'])
		opened.destroy()
	})

	it('rewrites a touched block only with allowed changes', () => {
		const opened = openSource(original)
		opened.replace('star two', 'star twoo')
		const result = opened.save()
		expect(result.text).toContain('- star one\n- star twoo')
		expect(result.text).toContain('Setext heading\n--------------')
		expect(result.text).toContain('***')
		opened.destroy()
	})

	it('keeps the line ending style and the final newline as the file had them', () => {
		for (const [original, expected] of [
			['alpha beta\r\n\r\ngamma\r\n', 'alpha beta\r\n\r\ndelta\r\n'],
			['alpha beta\n\ngamma', 'alpha beta\n\ndelta'],
			['alpha beta\n\ngamma\n\n\n', 'alpha beta\n\ndelta\n\n\n'],
		] as const) {
			const opened = openSource(original)
			opened.replace('gamma', 'delta')
			expect(opened.save().text).toBe(expected)
			opened.destroy()
		}
	})

	it('keeps the blank lines between blocks', () => {
		const original = 'one\n\n\n\ntwo\n\nthree\n'
		const opened = openSource(original)
		opened.replace('three', 'threee')
		expect(opened.save().text).toBe('one\n\n\n\ntwo\n\nthreee\n')
		opened.destroy()
	})
})

describe('line breaks inside a touched block', () => {
	// The read view (remark-breaks) shows a single line break as a line break,
	// so the editor keeps it as a hard break and writes a trailing backslash,
	// inside the block the person touched only.
	const original =
		'First line of a hand wrapped\nparagraph that continues\nand ends here.\n\nOther text\n'

	it('leaves a hand-wrapped paragraph alone when another block is edited', () => {
		const opened = openSource(original)
		opened.replace('Other', 'Another')
		expect(opened.save().text).toBe(original.replace('Other', 'Another'))
		opened.destroy()
	})

	it('allows a trailing backslash in the touched hand-wrapped paragraph', () => {
		const opened = openSource(original)
		opened.replace('continues', 'goes on')
		expect(opened.save().text).toBe(
			'First line of a hand wrapped\\\nparagraph that goes on\\\nand ends here.\n\nOther text\n',
		)
		opened.destroy()
	})
})

describe('images and headings', () => {
	it('keeps an image alone on a line and an image inside a paragraph', () => {
		const original =
			'# T\n\n![alt](a.png)\n\ntext with ![b](b.png "the title") inline\n\nlast word\n'
		const opened = openSource(original)
		opened.replace('last', 'LAST')
		const result = opened.save()
		expect(result.text).toBe(original.replace('last', 'LAST'))
		opened.destroy()
	})

	it('keeps heading levels 4 and 1 when another block is edited and when they are edited', () => {
		const original = '#### Four\n\n# One\n\nbody here\n'
		const opened = openSource(original)
		opened.replace('Four', 'Fourth')
		expect(opened.save().text).toBe('#### Fourth\n\n# One\n\nbody here\n')
		opened.destroy()
	})
})

describe('loss check', () => {
	const original = 'Last paragraph with [a link](https://x.com "the title") inside.\n\nOther text\n'

	it('refuses to rewrite a block whose link title the editor would drop', () => {
		const opened = openSource(original)
		opened.replace('Last', 'Final')
		const result = opened.save()
		expect(result.text).toBe(original)
		expect(result.refused).toEqual([{ construct: 'link_title', blocks: [0] }])
		opened.destroy()
	})

	it('still rewrites other blocks in the same save', () => {
		const opened = openSource(original)
		opened.replace('Last', 'Final')
		opened.replace('Other', 'Another')
		const result = opened.save()
		expect(result.text).toBe(original.replace('Other', 'Another'))
		expect(result.refused).toHaveLength(1)
		opened.destroy()
	})
})

describe('read-only list', () => {
	it.each([
		['front matter', '---\ntitle: x\n---\n\n# Hi\n', 'front_matter'],
		['raw html', '# Hi\n\n<div>x</div>\n', 'raw_html'],
		['an html comment', '# Hi\n\n<!-- note -->\n\ntext\n', 'raw_html'],
		['a line break tag', 'text <br> more\n', 'raw_html'],
		['a line break tag in capitals', 'text <BR> more\n', 'raw_html'],
		['an image tag', 'text <img src="a.png"> more\n', 'raw_html'],
		['a details block', '<details>\n<summary>s</summary>\n\nbody\n\n</details>\n', 'raw_html'],
		['a closing tag', 'text </div> more\n', 'raw_html'],
		['an element that is also a likely placeholder', 'use <label> here\n', 'raw_html'],
		['a title tag', 'x <title> y\n', 'raw_html'],
		['a footnote', 'Text[^1]\n\n[^1]: note\n', 'footnote'],
		['a link reference definition', 'See [a][1]\n\n[1]: https://x.com\n', 'link_reference'],
	])('opens read-only for %s', (_name, markdown, cause) => {
		const opened = openSource(markdown)
		expect(opened.cause).toBe(cause)
		expect(opened.session).toBeNull()
		opened.destroy()
	})

	it('does not read a divider at the top as front matter', () => {
		const opened = openSource('---\n\nText\n\n---\n\nMore\n')
		expect(opened.cause).toBeNull()
		opened.destroy()
	})

	// Angle-bracket words that are not HTML elements are placeholders, held as
	// plain text. Hyphenated names count as placeholders too (CTO ruling).
	it.each([
		['a placeholder', 'Use <owner> in the path.\n'],
		['a placeholder alone on a line', '<owner>\n\nmore\n'],
		['a placeholder in capitals', 'Use <PR> and <Task-ID> here.\n'],
		['a hyphenated name', 'Use <agent-id> here.\n'],
		['a tag inside a code span', 'Use `<div>` here.\n'],
		['a tag inside a code fence', '```html\n<div>x</div>\n```\n'],
		['an autolink', 'See <https://example.com> now.\n'],
	])('opens %s editable', (_name, markdown) => {
		const opened = openSource(markdown)
		expect(opened.cause).toBeNull()
		opened.destroy()
	})
})

describe('placeholders in angle brackets', () => {
	const original = 'Use <owner> and <agent-id> in the path, with more words here.\n\nother text\n'

	it('leaves the placeholders as written when another block is edited', () => {
		const opened = openSource(original)
		opened.replace('other', 'another')
		expect(opened.save().text).toBe(original.replace('other', 'another'))
		opened.destroy()
	})

	it('writes the placeholders back with a backslash, not as entities, when their block is edited', () => {
		const opened = openSource(original)
		opened.replace('more words', 'extra words')
		const result = opened.save()
		expect(result.refused).toEqual([])
		expect(result.text).toBe(
			'Use \\<owner> and \\<agent-id> in the path, with extra words here.\n\nother text\n',
		)
		opened.destroy()
	})

	it('shows the same words in the editor before and after the edit', () => {
		const opened = openSource(original)
		opened.replace('more words', 'extra words')
		const after = opened.save().text
		const reopened = openSource(after)
		expect(reopened.editor.getText()).toContain('Use <owner> and <agent-id> in the path')
		expect(openSource(original).editor.getText()).toContain(
			'Use <owner> and <agent-id> in the path',
		)
		opened.destroy()
		reopened.destroy()
	})
})
