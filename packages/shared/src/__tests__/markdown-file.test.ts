import { describe, expect, it } from 'vitest'
import { isMarkdownFile } from '../markdown-file'

describe('isMarkdownFile', () => {
	it('accepts the text/markdown MIME type whatever the name', () => {
		expect(isMarkdownFile({ name: 'readme', mimeType: 'text/markdown' })).toBe(true)
	})

	it('accepts text/markdown with parameters and in any case', () => {
		expect(isMarkdownFile({ name: 'a.bin', mimeType: 'Text/Markdown; charset=utf-8' })).toBe(true)
	})

	it('accepts a text/plain file named report.md', () => {
		expect(isMarkdownFile({ name: 'report.md', mimeType: 'text/plain' })).toBe(true)
	})

	it('accepts a file named NOTES.MD', () => {
		expect(isMarkdownFile({ name: 'NOTES.MD', mimeType: 'application/octet-stream' })).toBe(true)
	})

	it('accepts the .markdown extension', () => {
		expect(isMarkdownFile({ name: 'plan.Markdown', mimeType: 'text/plain' })).toBe(true)
	})

	it('rejects a plain text file', () => {
		expect(isMarkdownFile({ name: 'notes.txt', mimeType: 'text/plain' })).toBe(false)
	})

	it('rejects a name that only contains md', () => {
		expect(isMarkdownFile({ name: 'md.json', mimeType: 'application/json' })).toBe(false)
		expect(isMarkdownFile({ name: 'file.mdx', mimeType: 'text/plain' })).toBe(false)
	})
})
