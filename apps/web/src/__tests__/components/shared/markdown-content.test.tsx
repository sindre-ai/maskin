import { MarkdownContent } from '@/components/shared/markdown-content'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const highlightSpy = vi.fn()

vi.mock('prism-react-renderer', async () => {
	const actual =
		await vi.importActual<typeof import('prism-react-renderer')>('prism-react-renderer')
	return {
		...actual,
		// biome-ignore lint/suspicious/noExplicitAny: forward whatever the inner Highlight accepts
		Highlight: (props: any) => {
			highlightSpy(props.code, props.language)
			return createElement(actual.Highlight, props)
		},
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

		describe('memoised highlight', () => {
			beforeEach(() => {
				highlightSpy.mockClear()
			})

			it('skips Prism tokenisation when the parent re-renders with the same code', () => {
				const md = '```ts\nconst hello = "world"\n```'
				const { rerender } = render(<MarkdownContent content={md} />)
				expect(highlightSpy).toHaveBeenCalledTimes(1)

				rerender(<MarkdownContent content={md} />)
				rerender(<MarkdownContent content={md} />)
				expect(highlightSpy).toHaveBeenCalledTimes(1)
			})

			it('re-tokenises when the code changes', () => {
				const a = '```ts\nconst answer = 1\n```'
				const b = '```ts\nconst answer = 2\n```'
				const { rerender } = render(<MarkdownContent content={a} />)
				expect(highlightSpy).toHaveBeenCalledTimes(1)

				rerender(<MarkdownContent content={b} />)
				expect(highlightSpy).toHaveBeenCalledTimes(2)
				expect(highlightSpy).toHaveBeenLastCalledWith('const answer = 2', 'ts')
			})
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
