import { MarkdownContent } from '@/components/shared/markdown-content'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('MarkdownContent', () => {
	it('renders markdown content', () => {
		render(<MarkdownContent content="**bold text**" />)
		expect(screen.getByText('bold text')).toBeInTheDocument()
	})

	it('shows placeholder when editable and content is empty', () => {
		render(<MarkdownContent content="" editable />)
		expect(screen.getByPlaceholderText('Click to add content...')).toBeInTheDocument()
	})

	it('enters edit mode on click when editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="some text" editable onChange={vi.fn()} />)

		await user.click(screen.getByText('some text'))
		expect(screen.getByRole('textbox')).toBeInTheDocument()
	})

	it('calls onChange on blur with modified content', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const textarea = screen.getByRole('textbox')
		await user.clear(textarea)
		await user.type(textarea, 'updated')
		await user.tab()

		expect(onChange).toHaveBeenCalledWith('updated')
	})

	it('does not call onChange when content unchanged', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		await user.tab()

		expect(onChange).not.toHaveBeenCalled()
	})

	it('does not enter edit mode when not editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="read only" />)

		await user.click(screen.getByText('read only'))
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})
})
