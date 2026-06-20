import { MarkdownContent } from '@/components/shared/markdown-content'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

	describe('fenced code blocks', () => {
		const writeText = vi.fn(() => Promise.resolve())
		const originalClipboard = navigator.clipboard

		beforeEach(() => {
			writeText.mockClear()
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText },
				configurable: true,
			})
		})

		afterEach(() => {
			if (originalClipboard) {
				Object.defineProperty(navigator, 'clipboard', {
					value: originalClipboard,
					configurable: true,
				})
			} else {
				Reflect.deleteProperty(navigator, 'clipboard')
			}
		})

		it('renders a fenced code block with a per-block copy button', () => {
			render(<MarkdownContent content={'```ts\nconst hello = "world"\n```'} />)
			expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument()
			// The block keeps the language label so the reader can tell at a
			// glance what's being highlighted.
			expect(screen.getByText('ts')).toBeInTheDocument()
		})

		it('copies the code (without trailing newline) when the copy button is clicked', async () => {
			render(<MarkdownContent content={'```ts\nconst hello = "world"\n```'} />)
			// Drive the click via fireEvent so userEvent's own clipboard mock
			// doesn't override the one this test installs.
			fireEvent.click(screen.getByRole('button', { name: /copy code/i }))
			await waitFor(() => expect(writeText).toHaveBeenCalledWith('const hello = "world"'))
			await waitFor(() =>
				expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
			)
		})

		it('still renders inline `code` spans unchanged when they appear in prose', () => {
			render(<MarkdownContent content={'Use `useEffect` for side effects.'} />)
			const inline = screen.getByText('useEffect')
			expect(inline.tagName).toBe('CODE')
		})

		it('keeps the copy button visible by default on touch (hover-revealed only on hover-capable devices)', () => {
			// The copy button used to be `opacity-0 group-hover:opacity-100` —
			// invisible on touch devices that have no `:hover` and no way to
			// focus a hidden button. The contract is: visible by default;
			// fades behind hover only on devices that actually have hover
			// (the `can-hover` variant maps to `@media (hover: hover)`).
			render(<MarkdownContent content={'```ts\nconst hello = "world"\n```'} />)
			const copy = screen.getByRole('button', { name: /copy code/i })
			expect(copy.className).toMatch(/(^|\s)opacity-100($|\s)/)
			expect(copy.className).toMatch(/can-hover:opacity-0/)
			expect(copy.className).toMatch(/can-hover:group-hover:opacity-100/)
			expect(copy.className).not.toMatch(/\bsm:opacity-0\b/)
			expect(copy.className).not.toMatch(/\bmd:opacity-0\b/)
		})
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
