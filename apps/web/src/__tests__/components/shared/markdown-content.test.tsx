import { MarkdownContent } from '@/components/shared/markdown-content'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Stub ResponsiveContainer so recharts mounts under jsdom (it measures 0×0
// otherwise and never renders the actual chart).
vi.mock('recharts', async () => {
	const actual = await vi.importActual<typeof import('recharts')>('recharts')
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
			<div style={{ width: 400, height: 200 }}>{children}</div>
		),
	}
})

const CHART_BLOCK = `\`\`\`chart
${JSON.stringify({
	type: 'bar',
	x: 'day',
	series: ['retention'],
	data: [{ day: 'Mon', retention: 38 }],
	caption: 'visual on',
})}
\`\`\``

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

	it('keeps a ```chart fenced block as a code block when renderVisuals is off (default)', () => {
		const { container } = render(<MarkdownContent content={CHART_BLOCK} />)
		expect(container.querySelector('pre')).not.toBeNull()
		expect(screen.queryByTestId('comment-chart')).not.toBeInTheDocument()
		expect(screen.queryByText('visual on')).not.toBeInTheDocument()
	})

	it('dispatches a ```chart fenced block to CommentVisual when renderVisuals is on', () => {
		render(<MarkdownContent content={CHART_BLOCK} renderVisuals />)
		expect(screen.getByTestId('comment-chart')).toBeInTheDocument()
		expect(screen.getByText('visual on')).toBeInTheDocument()
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
