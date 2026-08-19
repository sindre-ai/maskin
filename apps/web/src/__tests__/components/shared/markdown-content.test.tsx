import {
	MarkdownContent,
	caretOffsetInSource,
	continueListOnEnter,
	isIndentContext,
	shiftIndent,
} from '@/components/shared/markdown-content'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('recharts', async () => {
	const actual = await vi.importActual<typeof import('recharts')>('recharts')
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
			<div style={{ width: 600, height: 200 }}>{children}</div>
		),
	}
})

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

	it('leaves a link in the body clickable instead of opening the editor', async () => {
		const user = userEvent.setup()
		// A hash href — jsdom implements hash navigation, so clicking it does not
		// print an unimplemented-navigation warning over the rest of the suite.
		render(<MarkdownContent content="See [the docs](#docs) first." editable />)

		await user.click(screen.getByRole('link', { name: 'the docs' }))

		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'the docs' })).toBeInTheDocument()
	})

	it('puts the caret at the end when the click position cannot be mapped', async () => {
		const user = userEvent.setup()
		// jsdom implements neither caretPositionFromPoint nor caretRangeFromPoint,
		// so this exercises the fallback the browser path shares.
		render(<MarkdownContent content="Some existing prose." editable />)

		await user.click(screen.getByText('Some existing prose.'))

		const editor = screen.getByRole('textbox') as HTMLTextAreaElement
		expect(editor.selectionStart).toBe('Some existing prose.'.length)
	})

	it('commits the edit on Cmd+Enter', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content="before" editable onChange={onChange} />)

		await user.click(screen.getByText('before'))
		const editor = screen.getByRole('textbox')
		await user.type(editor, ' after')
		await user.keyboard('{Meta>}{Enter}{/Meta}')

		expect(onChange).toHaveBeenCalledWith('before after')
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('carries the list marker onto the next line when Enter is pressed', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content="- first" editable onChange={onChange} />)

		await user.click(screen.getByText('first'))
		await user.keyboard('{Enter}second')
		await user.keyboard('{Meta>}{Enter}{/Meta}')

		expect(onChange).toHaveBeenCalledWith('- first\n- second')
	})

	it('indents the current list item on Tab instead of leaving the field', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content={'- first\n- second'} editable onChange={onChange} />)

		await user.click(screen.getByText('second'))
		await user.tab()

		// Still editing — Tab was claimed as indentation, not as focus movement.
		expect(screen.getByRole('textbox')).toBeInTheDocument()
		await user.keyboard('{Meta>}{Enter}{/Meta}')
		expect(onChange).toHaveBeenCalledWith('- first\n  - second')
	})

	it('lets Tab move focus out when the caret is in plain prose', async () => {
		const onChange = vi.fn()
		const user = userEvent.setup()
		render(<MarkdownContent content="Just a paragraph." editable onChange={onChange} />)

		await user.click(screen.getByText('Just a paragraph.'))
		expect(screen.getByRole('textbox')).toBeInTheDocument()
		await user.tab()

		// Focus left, the editor closed, and nothing was rewritten.
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
		expect(onChange).not.toHaveBeenCalled()
	})

	it('formats the occurrence that was actually selected, not the first match', async () => {
		// jsdom has no layout, so every rect it reports is empty and the toolbar
		// declines to place itself. Stub a real one so the mapping this test is
		// actually about can run.
		const originalRect = Range.prototype.getBoundingClientRect
		Range.prototype.getBoundingClientRect = () =>
			({ left: 80, right: 120, top: 40, bottom: 60, width: 40, height: 20, x: 80, y: 40 }) as DOMRect
		const onChange = vi.fn()
		const source = 'Ship the retry now, not the retry later.'
		render(<MarkdownContent content={source} size="doc" editable onChange={onChange} />)

		fireEvent.click(screen.getByText(source))
		const field = screen.getByRole('textbox') as HTMLTextAreaElement
		const second = source.indexOf('retry', source.indexOf('retry') + 1)
		field.setSelectionRange(second, second + 'retry'.length)
		fireEvent.select(field)

		const bold = await waitFor(() => screen.getByRole('button', { name: 'Bold' }))
		fireEvent.mouseDown(bold)

		expect(field.value).toBe('Ship the retry now, not the **retry** later.')
		Range.prototype.getBoundingClientRect = originalRect
	})

	// Reading is not editing: a selection in the rendered prose must stay quiet.
	it('raises the toolbar only while the body is being edited', async () => {
		const source = 'Ship the retry now.'
		const { container } = render(
			<MarkdownContent content={source} size="doc" editable onChange={vi.fn()} />,
		)

		const paragraph = screen.getByText(source)
		const range = document.createRange()
		range.setStart(paragraph.firstChild as Text, 0)
		range.setEnd(paragraph.firstChild as Text, 4)
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
		fireEvent.mouseUp(container.firstChild as HTMLElement)

		expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
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

	it('renders a chart fenced block as a visual only when renderVisuals is on', () => {
		const spec = JSON.stringify({
			type: 'bar',
			x: 'day',
			series: ['v'],
			data: [{ day: 'Mon', v: 1 }],
			caption: 'visual-on',
		})
		const md = `before\n\n\`\`\`chart\n${spec}\n\`\`\`\n\nafter`

		const { rerender, container } = render(<MarkdownContent content={md} />)
		// renderVisuals defaults to false outside ActivityComment — the block
		// must stay a plain <pre><code> in object-document body markdown.
		expect(container.querySelector('pre')).not.toBeNull()
		expect(screen.queryByText('visual-on')).toBeNull()

		rerender(<MarkdownContent content={md} renderVisuals />)
		expect(screen.getByText('visual-on')).toBeInTheDocument()
		expect(container.querySelector('pre')).toBeNull()
	})

	it('shows the inline fallback note when a chart spec is malformed', () => {
		const md = 'lead\n\n```chart\n{not valid json\n```\n\ntail'
		render(<MarkdownContent content={md} renderVisuals />)
		expect(screen.getByText(/Couldn’t render chart/)).toBeInTheDocument()
		expect(screen.getByText('lead')).toBeInTheDocument()
		expect(screen.getByText('tail')).toBeInTheDocument()
	})

	it('renders @mentions as chips inside formatted markdown', () => {
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
})

describe('caretOffsetInSource', () => {
	it('maps an offset inside a rendered run to the same spot in the source', () => {
		const source = 'The retry window is still open.'
		expect(caretOffsetInSource(source, 'The retry window is still open.', 4)).toBe(4)
	})

	it('locates a run that appears partway through the source', () => {
		const source = '# Heading\n\nThe body paragraph.'
		expect(caretOffsetInSource(source, 'The body paragraph.', 4)).toBe(
			source.indexOf('The body paragraph.') + 4,
		)
	})

	it('discounts leading whitespace the renderer added', () => {
		const source = 'Body text here.'
		expect(caretOffsetInSource(source, '  Body text here.', 6)).toBe(4)
	})

	it('clamps an offset past the end of the run', () => {
		const source = 'Short.'
		expect(caretOffsetInSource(source, 'Short.', 99)).toBe(6)
	})

	it('returns null for whitespace-only or unlocatable runs', () => {
		expect(caretOffsetInSource('anything', '   ', 1)).toBeNull()
		expect(caretOffsetInSource('anything', 'not in here', 1)).toBeNull()
	})
})

describe('continueListOnEnter', () => {
	it('repeats a bullet marker', () => {
		expect(continueListOnEnter('- first', 7, 7)).toEqual({
			value: '- first\n- ',
			start: 10,
			end: 10,
		})
	})

	it('increments an ordered marker', () => {
		expect(continueListOnEnter('1. first', 8, 8)?.value).toBe('1. first\n2. ')
		expect(continueListOnEnter('4) first', 8, 8)?.value).toBe('4) first\n5) ')
	})

	it('keeps the indent of a nested item', () => {
		expect(continueListOnEnter('  - nested', 10, 10)?.value).toBe('  - nested\n  - ')
	})

	it('starts the next task unchecked', () => {
		expect(continueListOnEnter('- [x] done', 10, 10)?.value).toBe('- [x] done\n- [ ] ')
	})

	it('ends the list when Enter lands on an empty item', () => {
		expect(continueListOnEnter('- first\n- ', 10, 10)).toEqual({
			value: '- first\n',
			start: 8,
			end: 8,
		})
	})

	it('splits an item when the caret is mid-line', () => {
		expect(continueListOnEnter('- first', 5, 5)?.value).toBe('- fir\n- st')
	})

	it('leaves prose and selections to the browser', () => {
		expect(continueListOnEnter('just prose', 10, 10)).toBeNull()
		expect(continueListOnEnter('- first', 2, 7)).toBeNull()
	})
})

describe('isIndentContext', () => {
	it('claims Tab on a list line', () => {
		expect(isIndentContext('- item', 6, 6)).toBe(true)
		expect(isIndentContext('  1. item', 9, 9)).toBe(true)
	})

	it('claims Tab across a multi-line selection', () => {
		expect(isIndentContext('one\ntwo', 1, 6)).toBe(true)
	})

	it('leaves Tab alone in plain prose', () => {
		expect(isIndentContext('just prose', 4, 4)).toBe(false)
	})
})

describe('shiftIndent', () => {
	it('indents the caret line and moves the selection with it', () => {
		expect(shiftIndent('- item', 6, 6, false)).toEqual({
			value: '  - item',
			start: 8,
			end: 8,
		})
	})

	it('outdents two spaces, or a tab', () => {
		expect(shiftIndent('  - item', 8, 8, true).value).toBe('- item')
		expect(shiftIndent('\t- item', 7, 7, true).value).toBe('- item')
	})

	it('is a no-op outdenting a line that has no indent', () => {
		expect(shiftIndent('- item', 6, 6, true)).toEqual({ value: '- item', start: 6, end: 6 })
	})

	it('shifts every line a selection touches, skipping blank ones', () => {
		expect(shiftIndent('- one\n\n- two', 2, 10, false).value).toBe('  - one\n\n  - two')
	})
})
