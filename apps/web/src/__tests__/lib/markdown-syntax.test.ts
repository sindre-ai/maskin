import { hasMarkdownSyntax } from '@/lib/markdown-syntax'
import { describe, expect, it } from 'vitest'

describe('hasMarkdownSyntax', () => {
	it.each([
		'**bold**',
		'some *italic* text',
		'~~gone~~',
		'run `pnpm dev`',
		'[the board](https://example.com)',
		'- one\n- two',
		'* one',
		'1. first',
		'2) second',
		'> quoted',
		'```\ncode\n```',
		'| a | b |\n| --- | --- |\n| 1 | 2 |',
		'a | b\n--- | ---\n1 | 2',
	])('sees markdown in %j', (text) => {
		expect(hasMarkdownSyntax(text)).toBe(true)
	})

	it.each([
		'Here is what I found.',
		'2 * 3 * 4 is 24',
		'a lone * star',
		'snake_case_name and file_name.ts',
		'see https://example.com/a-b',
		'1.5 million',
		'a -b flag',
		'---',
		'email me @ noon',
	])('leaves %j as plain text', (text) => {
		expect(hasMarkdownSyntax(text)).toBe(false)
	})
})
