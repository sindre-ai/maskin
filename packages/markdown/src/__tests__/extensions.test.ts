// The fixture suite must run against the editor the app ships (CTO rider 1),
// not a copy of it. Both the React editor and the headless round-trip helper
// build their extensions with buildExtensions; these tests fail if either one
// grows an extension list of its own.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { roundTrip } from '../roundtrip'
import { openSource } from './open-source'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('one editor setup', () => {
	it('mounts the editor from buildExtensions and carries no extension list of its own', () => {
		const editor = readFileSync(join(SRC, 'react', 'editor.tsx'), 'utf8')
		expect(editor).toContain("from '../extensions'")
		expect(editor).not.toContain('StarterKit')
		expect(editor).not.toContain('CodeBlockLowlight')
	})

	it('builds the round-trip helper from buildExtensions and carries no extension list of its own', () => {
		const helper = readFileSync(join(SRC, 'roundtrip.ts'), 'utf8')
		expect(helper).toContain("from './extensions'")
		expect(helper).not.toContain('StarterKit')
		expect(helper).not.toContain('CodeBlockLowlight')
	})
})

describe('headings', () => {
	it.each([1, 2, 3, 4, 5, 6])('keeps a level %i heading', (level) => {
		const marker = '#'.repeat(level)
		const opened = openSource(`${marker} Heading\n\nbody\n`)
		expect(opened.editor.state.doc.firstChild?.attrs.level).toBe(level)
		expect(roundTrip(`${marker} Heading\n`)).toBe(`${marker} Heading`)
		opened.destroy()
	})
})

describe('image node', () => {
	it('is an inline node in the editor schema', () => {
		const opened = openSource('text\n')
		expect(opened.editor.schema.nodes.image?.isInline).toBe(true)
		opened.destroy()
	})

	it('round-trips an image alone on a line and an image inside a paragraph', () => {
		expect(roundTrip('![alt](a.png)\n\ntext ![b](b.png "the title") more\n')).toBe(
			'![alt](a.png)\n\ntext ![b](b.png "the title") more',
		)
	})
})
