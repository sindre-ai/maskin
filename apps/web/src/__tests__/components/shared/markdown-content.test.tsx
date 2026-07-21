import { MarkdownContent } from '@/components/shared/markdown-content'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

// Stub the TipTap editor mount — this suite covers the MarkdownContent
// shell (view/edit toggle, mention chips, chart visuals, placeholder). The
// editor itself is exercised in tiptap-editor.test.tsx where mounting the
// real ProseMirror view is worth the cost.
vi.mock('@/components/editor/tiptap-editor', () => ({
	TipTapEditor: ({
		value,
		onBlur,
	}: {
		value: string
		onChange: (v: string) => void
		onBlur?: () => void
	}) => (
		<div
			data-testid="tiptap-editor-stub"
			contentEditable
			suppressContentEditableWarning
			onBlur={() => onBlur?.()}
		>
			{value}
		</div>
	),
}))

describe('MarkdownContent', () => {
	it('renders markdown content', () => {
		render(<MarkdownContent content="**bold text**" />)
		expect(screen.getByText('bold text')).toBeInTheDocument()
	})

	it('shows placeholder when editable and content is empty', () => {
		render(<MarkdownContent content="" editable />)
		expect(screen.getByPlaceholderText('Click to add content...')).toBeInTheDocument()
	})

	it('mounts the TipTap editor on click when editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="some text" editable onChange={vi.fn()} />)

		await user.click(screen.getByText('some text'))
		expect(screen.getByTestId('tiptap-editor-mount')).toBeInTheDocument()
		expect(screen.getByTestId('tiptap-editor-stub')).toBeInTheDocument()
	})

	it('exits edit mode on blur', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="original" editable onChange={vi.fn()} />)

		await user.click(screen.getByText('original'))
		expect(screen.getByTestId('tiptap-editor-mount')).toBeInTheDocument()

		act(() => {
			fireEvent.blur(screen.getByTestId('tiptap-editor-stub'))
		})
		expect(screen.queryByTestId('tiptap-editor-mount')).not.toBeInTheDocument()
		expect(screen.getByText('original')).toBeInTheDocument()
	})

	it('does not enter edit mode when not editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="read only" />)

		await user.click(screen.getByText('read only'))
		expect(screen.queryByTestId('tiptap-editor-mount')).not.toBeInTheDocument()
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
