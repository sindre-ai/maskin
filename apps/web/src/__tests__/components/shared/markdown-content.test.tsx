import { MarkdownContent } from '@/components/shared/markdown-content'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Manually creates a collapsed selection at the true end of `el`'s content
// (descending into the last text node, not just el's last child) so handlers
// that read `window.getSelection()` (paste / Enter-key fallback) have a range
// to work with — jsdom doesn't create one automatically on focus like a real
// browser. Mirrors the component's own `rangeAtEnd` helper.
function placeCaretAtEnd(el: HTMLElement) {
	let node: Node = el
	while (node.lastChild) node = node.lastChild
	const range = document.createRange()
	if (node.nodeType === Node.TEXT_NODE) {
		const length = node.textContent?.length ?? 0
		range.setStart(node, length)
		range.setEnd(node, length)
	} else {
		range.selectNodeContents(node)
		range.collapse(false)
	}
	const selection = window.getSelection()
	selection?.removeAllRanges()
	selection?.addRange(range)
}

describe('MarkdownContent', () => {
	it('renders markdown content', () => {
		render(<MarkdownContent content="**bold text**" />)
		expect(screen.getByText('bold text')).toBeInTheDocument()
	})

	it('shows placeholder when editable and content is empty', () => {
		render(<MarkdownContent content="" editable />)
		expect(screen.getByPlaceholderText('Click to add content...')).toBeInTheDocument()
	})

	it('enters edit mode on click when editable, preserving formatting', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="some **bold** text" editable onChange={vi.fn()} />)

		await user.click(screen.getByText('bold'))
		const box = screen.getByRole('textbox')
		expect(box).toHaveAttribute('contenteditable', 'true')
		// Formatting stays visible while editing instead of collapsing to raw markdown.
		const strong = box.querySelector('strong')
		expect(strong).not.toBeNull()
		expect(strong).toHaveTextContent('bold')
	})

	it('calls onChange on blur with the round-tripped markdown', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const box = screen.getByRole('textbox')
		box.innerHTML = '<p>updated</p>'
		fireEvent.input(box)
		fireEvent.blur(box)

		expect(onChange).toHaveBeenCalledWith('updated')
	})

	it('does not call onChange when content unchanged', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const box = screen.getByRole('textbox')
		fireEvent.blur(box)

		expect(onChange).not.toHaveBeenCalled()
	})

	it('does not enter edit mode when not editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="read only" />)

		await user.click(screen.getByText('read only'))
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('suppresses disallowed elements but keeps their text', () => {
		const { container } = render(
			<MarkdownContent
				content={'# Heading text\n\nbody'}
				disallowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']}
			/>,
		)
		expect(container.querySelector('h1')).toBeNull()
		expect(screen.getByText('Heading text')).toBeInTheDocument()
		expect(screen.getByText('body')).toBeInTheDocument()
	})

	it('suppresses disallowed elements in edit mode too', async () => {
		const user = userEvent.setup()
		render(
			<MarkdownContent
				content={'# Heading text\n\nbody'}
				disallowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']}
				editable
				onChange={vi.fn()}
			/>,
		)
		await user.click(screen.getByText('Heading text'))
		const box = screen.getByRole('textbox')
		expect(box.querySelector('h1')).toBeNull()
		expect(box).toHaveTextContent('Heading text')
	})

	it('renders @mentions as chips inside formatted markdown in view mode', () => {
		const actors = [
			{
				id: 'a1',
				name: 'Magnus',
				type: 'human',
				email: null,
				description: null,
				isSystem: false,
				agentState: 'idle' as const,
			},
		]
		render(<MarkdownContent content="Hello @Magnus this is **important**" mentionActors={actors} />)
		const chip = screen.getByText('@Magnus')
		expect(chip.tagName).toBe('SPAN')
		const strong = screen.getByText('important')
		expect(strong.tagName).toBe('STRONG')
	})

	it('renders @mentions as plain text (not chips) while editing', async () => {
		const user = userEvent.setup()
		const actors = [
			{
				id: 'a1',
				name: 'Magnus',
				type: 'human',
				email: null,
				description: null,
				isSystem: false,
				agentState: 'idle' as const,
			},
		]
		render(
			<MarkdownContent
				content="Hello @Magnus this is important"
				mentionActors={actors}
				editable
				onChange={vi.fn()}
			/>,
		)
		await user.click(screen.getByText(/Hello/))
		const box = screen.getByRole('textbox')
		expect(box.querySelector('span')).toBeNull()
		expect(box.querySelector('button')).toBeNull()
		expect(box).toHaveTextContent('Hello @Magnus this is important')
	})

	it('sanitizes pasted content to plain text', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const box = screen.getByRole('textbox')
		placeCaretAtEnd(box)

		const dataTransfer = {
			getData: (type: string) => (type === 'text/plain' ? ' pasted' : '<b>pasted</b>'),
		} as unknown as DataTransfer
		fireEvent.paste(box, { clipboardData: dataTransfer })

		expect(box.querySelector('b')).toBeNull()
		expect(box).toHaveTextContent('original pasted')
	})

	it('inserts a flat <br> on Enter so line breaks round-trip through turndown', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="line one" editable onChange={onChange} />)

		await user.click(screen.getByText('line one'))
		const box = screen.getByRole('textbox')
		placeCaretAtEnd(box)

		fireEvent.keyDown(box, { key: 'Enter' })
		expect(box.querySelectorAll('br')).toHaveLength(1)

		fireEvent.input(box)
		fireEvent.blur(box)
		expect(onChange).toHaveBeenCalledWith('line one\n')
	})

	it('keeps live-edited DOM stable across unrelated re-renders (cursor stability proxy)', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		const { rerender } = render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const box = screen.getByRole('textbox')
		box.innerHTML = '<p>mid-edit change</p>'
		fireEvent.input(box)

		// Re-rendering with identical props must not stomp on the live DOM: the
		// editingHtml string passed to dangerouslySetInnerHTML hasn't changed, so
		// React must skip the write and leave the manually-mutated DOM untouched.
		rerender(<MarkdownContent content="original" editable onChange={onChange} />)
		expect(box.innerHTML).toBe('<p>mid-edit change</p>')
	})

	it('converts "**bold**" typed from scratch into live formatting and saves the round-tripped markdown', async () => {
		const onChange = vi.fn()
		render(<MarkdownContent content="" editable onChange={onChange} />)

		await fireEvent.focus(screen.getByPlaceholderText('Click to add content...'))
		const box = screen.getByRole('textbox')

		const textNode = document.createTextNode('**bold**')
		box.appendChild(textNode)
		placeCaretAtEnd(box)
		fireEvent.input(box)

		expect(box.querySelector('strong')).toHaveTextContent('bold')
		expect(box).not.toHaveTextContent('**')

		fireEvent.blur(box)
		expect(onChange).toHaveBeenCalledWith('**bold**')
	})

	it('converts "# " typed from scratch into a live heading and saves the round-tripped markdown', async () => {
		const onChange = vi.fn()
		render(<MarkdownContent content="" editable onChange={onChange} />)

		await fireEvent.focus(screen.getByPlaceholderText('Click to add content...'))
		const box = screen.getByRole('textbox')

		const markerNode = document.createTextNode('# ')
		box.appendChild(markerNode)
		placeCaretAtEnd(box)
		fireEvent.input(box)

		const heading = box.querySelector('h1')
		expect(heading).not.toBeNull()
		expect(box).not.toHaveTextContent('#')

		// Continue typing the heading's own text, same as a user would after the
		// live conversion moves the cursor inside the new (empty) <h1>.
		const headingText = document.createTextNode('Heading')
		heading?.appendChild(headingText)
		placeCaretAtEnd(box)
		fireEvent.input(box)

		fireEvent.blur(box)
		expect(onChange).toHaveBeenCalledWith('# Heading')
	})

	it('does not live-convert pasted content, even when it ends in a trigger pattern', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content="original " editable onChange={onChange} />)

		await user.click(screen.getByText(/original/))
		const box = screen.getByRole('textbox')
		placeCaretAtEnd(box)

		const dataTransfer = {
			getData: (type: string) => (type === 'text/plain' ? '**bold**' : '<b>bold</b>'),
		} as unknown as DataTransfer
		fireEvent.paste(box, { clipboardData: dataTransfer })

		expect(box.querySelector('strong')).toBeNull()
		expect(box).toHaveTextContent('**bold**')
	})

	it('skips conversion while an IME composition is in progress', async () => {
		const onChange = vi.fn()
		render(<MarkdownContent content="" editable onChange={onChange} />)

		await fireEvent.focus(screen.getByPlaceholderText('Click to add content...'))
		const box = screen.getByRole('textbox')

		const textNode = document.createTextNode('**bold**')
		box.appendChild(textNode)
		placeCaretAtEnd(box)

		box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))

		expect(box.querySelector('strong')).toBeNull()
		expect(box).toHaveTextContent('**bold**')
	})
})
