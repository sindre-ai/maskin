import { FileReadView, hasBlockStructure } from '@/components/files/file-read-view'
import type { FileDetail } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TestWrapper } from '../../setup'

const TABLE_AND_BULLETS = [
	'# Calls',
	'',
	'- First point',
	'- Second point',
	'',
	'|#|Firm|Seconds|',
	'|--|--|--|',
	'|1|Tennberg ApS|126|',
	'|2|Hartmann ApS|53|',
	'',
].join('\n')

const TRANSCRIPT = [
	'# Weekly sync',
	'',
	'Magnus: Let us start with the release.',
	'Sebastian: The build is green. We ship today.',
	'',
].join('\n')

function file(content: string): FileDetail {
	return {
		id: 'file-1',
		name: 'notes.md',
		mimeType: 'text/markdown',
		content,
		encoding: 'utf8',
		sizeBytes: content.length,
		createdAt: '2026-11-16T10:00:00Z',
	} as FileDetail
}

function mount(content: string) {
	return render(
		<FileReadView
			file={file(content)}
			workspaceId="ws-1"
			authorName={null}
			attachers={[]}
			onOpenEditor={() => undefined}
			onAsk={() => undefined}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('hasBlockStructure', () => {
	it('is true for a table, a bullet list, a numbered list and a code fence', () => {
		expect(hasBlockStructure('|a|b|\n|--|--|\n|1|2|')).toBe(true)
		expect(hasBlockStructure('| a | b |\n| :-- | --: |\n| 1 | 2 |')).toBe(true)
		expect(hasBlockStructure('intro\n\n- one\n- two')).toBe(true)
		expect(hasBlockStructure('1. one\n2. two')).toBe(true)
		expect(hasBlockStructure('text\n```\ncode\n```')).toBe(true)
	})

	it('is false for prose, headings, a pipe in a sentence and a horizontal rule', () => {
		expect(hasBlockStructure(TRANSCRIPT)).toBe(false)
		expect(hasBlockStructure('Use a | b to choose.\nNext line.')).toBe(false)
		expect(hasBlockStructure('one\n\n---\n\n* * *\n\ntwo')).toBe(false)
	})
})

describe('FileReadView', () => {
	it('shows a file with a table and bullets as a document, not as a row per line', async () => {
		const { container } = mount(TABLE_AND_BULLETS)

		expect(await screen.findByRole('table')).toBeInTheDocument()
		expect(container.querySelectorAll('li')).toHaveLength(2)
		expect(screen.getByRole('columnheader', { name: 'Firm' })).toBeInTheDocument()
		expect(screen.queryByText('Tap a line to pin a comment')).toBeNull()
		expect(screen.getByRole('button', { name: 'Ask about this file' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Edit and review' })).toBeInTheDocument()
	})

	it('keeps plain prose as one tappable row per line', () => {
		mount(TRANSCRIPT)

		expect(screen.getByText('Tap a line to pin a comment')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Magnus: Let us start with the release.' }),
		).toBeInTheDocument()
		expect(screen.queryByRole('table')).toBeNull()
	})
})
