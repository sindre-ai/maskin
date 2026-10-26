import { MarkdownRenderer } from '@maskin/markdown/react'
import { MarkdownEditor, type MarkdownEditorRef } from '@maskin/markdown/react/editor'
import { roundTrip } from '@maskin/markdown/roundtrip'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

// The v3 list, quote and checkbox look lives in one `.maskin-prose` block in
// app.css. These tests pin the structure that block keys on, in the read
// renderer and in the editor, and that the look never reaches saved markdown.

const SAMPLE = [
	'## Lists',
	'',
	'- first',
	'- second',
	'',
	'1. one',
	'2. two',
	'',
	'> a quiet quote',
	'',
	'- [ ] open task',
	'- [x] done task',
	'',
	'# Top level',
].join('\n')

describe('v3 prose look: read renderer', () => {
	it('mounts under the shared prose class', () => {
		const { container } = render(<MarkdownRenderer content={SAMPLE} />)
		expect(container.querySelector('.maskin-prose')).not.toBeNull()
	})

	it('renders the structures the look targets', () => {
		const { container } = render(<MarkdownRenderer content={SAMPLE} size="doc" />)
		const prose = container.querySelector('.maskin-prose') as HTMLElement
		expect(prose.querySelectorAll('ul:not(.contains-task-list) > li')).toHaveLength(2)
		expect(prose.querySelectorAll('ol > li')).toHaveLength(2)
		expect(prose.querySelector('blockquote')?.textContent).toContain('a quiet quote')
		const boxes = prose.querySelectorAll<HTMLInputElement>(
			'ul.contains-task-list > li.task-list-item > input[type="checkbox"]',
		)
		expect(boxes).toHaveLength(2)
		expect(boxes[0]?.checked).toBe(false)
		expect(boxes[1]?.checked).toBe(true)
		expect(prose.querySelector('h1')?.textContent).toBe('Top level')
	})

	it('keeps the checkbox inside a paragraph for a loose task list', () => {
		const { container } = render(<MarkdownRenderer content={'- [ ] a\n\n- [x] b'} />)
		expect(
			container.querySelectorAll('li.task-list-item > p:first-child > input[type="checkbox"]'),
		).toHaveLength(2)
	})
})

describe('v3 prose look: editor', () => {
	it('mounts under the same shared prose class', async () => {
		const { container } = render(<MarkdownEditor value={SAMPLE} onChange={() => {}} />)
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
		expect(container.querySelector('.maskin-prose .ProseMirror')).not.toBeNull()
	})

	it('keeps a caller className next to the shared prose class', async () => {
		const { container } = render(
			<MarkdownEditor value={SAMPLE} onChange={() => {}} className="custom-wrap" />,
		)
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
		expect(container.querySelector('.maskin-prose.custom-wrap')).not.toBeNull()
	})

	it('renders task items the look targets and toggles one on click', async () => {
		const { container } = render(<MarkdownEditor value={SAMPLE} onChange={() => {}} />)
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
		const itemSelector = '.ProseMirror ul[data-type="taskList"] > li[data-checked]'
		const items = container.querySelectorAll<HTMLElement>(itemSelector)
		expect(items).toHaveLength(2)
		expect(items[0]?.getAttribute('data-checked')).toBe('false')
		expect(items[1]?.getAttribute('data-checked')).toBe('true')

		const box = items[0]?.querySelector('input[type="checkbox"]') as HTMLInputElement
		fireEvent.click(box)
		await waitFor(() =>
			expect(container.querySelector(itemSelector)?.getAttribute('data-checked')).toBe('true'),
		)
	})
})

describe('v3 prose look: saved markdown', () => {
	it('is what the shared round-trip pipeline produces, with the look mounted', async () => {
		const ref = createRef<MarkdownEditorRef>()
		const { container } = render(<MarkdownEditor ref={ref} value={SAMPLE} onChange={() => {}} />)
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
		expect(ref.current?.getMarkdown()).toBe(roundTrip(SAMPLE))
	})
})
