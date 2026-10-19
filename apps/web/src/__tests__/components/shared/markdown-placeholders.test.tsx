import { MarkdownRenderer } from '@maskin/markdown/react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

// A placeholder such as <owner> in prose is plain text to the editor. The read
// view must show the same words for the file as written by an agent and for the
// same file after the editor rewrote the block (a backslash before the bracket).
describe('MarkdownRenderer placeholders in angle brackets', () => {
	const asWritten = 'Use <owner> and <agent-id> in the path.'
	const afterEdit = 'Use \\<owner> and \\<agent-id> in the path.'

	it('shows the placeholder words as text', () => {
		const { container } = render(<MarkdownRenderer content={asWritten} />)
		expect(container.textContent).toContain('Use <owner> and <agent-id> in the path.')
	})

	it('shows the same words after the editor wrote the block back with a backslash', () => {
		const before = render(<MarkdownRenderer content={asWritten} />)
		const after = render(<MarkdownRenderer content={afterEdit} />)
		expect(after.container.textContent).toBe(before.container.textContent)
	})
})
