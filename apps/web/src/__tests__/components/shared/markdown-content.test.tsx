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

	it('emits heading ids from rehype-slug for h2/h3 headings', () => {
		const { container } = render(<MarkdownContent content={'## First section\n\n### Sub'} />)
		const h2 = container.querySelector('h2')
		const h3 = container.querySelector('h3')
		expect(h2?.id).toBe('first-section')
		expect(h3?.id).toBe('sub')
	})

	it('renders a [[uuid]] wikilink as a link to the wiki article when workspaceId is set', () => {
		const uuid = '11111111-2222-3333-4444-555555555555'
		render(<MarkdownContent content={`See [[${uuid}]] for details.`} workspaceId="ws-1" />)
		const link = screen.getByRole('link', { name: /^11111111/ })
		expect(link).toHaveAttribute('href', `/ws-1/wiki/${uuid}`)
	})

	it('renders a [[Title]] wikilink as a knowledge-scoped search link', () => {
		render(<MarkdownContent content="See [[Canonical customer table]] for details." workspaceId="ws-1" />)
		const link = screen.getByRole('link', { name: 'Canonical customer table' })
		expect(link).toHaveAttribute(
			'href',
			'/ws-1/objects?type=knowledge&search=Canonical%20customer%20table',
		)
	})

	it('supports [[uuid|label]] syntax with a custom link label', () => {
		const uuid = '11111111-2222-3333-4444-555555555555'
		render(
			<MarkdownContent content={`See [[${uuid}|the canonical table]].`} workspaceId="ws-1" />,
		)
		const link = screen.getByRole('link', { name: 'the canonical table' })
		expect(link).toHaveAttribute('href', `/ws-1/wiki/${uuid}`)
	})

	it('passes [[…]] through as literal text when workspaceId is not provided', () => {
		render(<MarkdownContent content="See [[Title]] for details." />)
		expect(screen.queryByRole('link')).toBeNull()
		expect(screen.getByText(/\[\[Title]]/)).toBeInTheDocument()
	})
})
