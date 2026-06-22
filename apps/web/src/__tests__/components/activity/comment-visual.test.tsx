import { CommentVisual } from '@/components/activity/comment-visual'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('recharts', async () => {
	const actual = await vi.importActual<typeof import('recharts')>('recharts')
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
			<div data-testid="rc-wrap" style={{ width: 400, height: 200 }}>
				{children}
			</div>
		),
	}
})

const validSpec = JSON.stringify({
	type: 'bar',
	x: 'day',
	series: ['retention'],
	data: [{ day: 'Mon', retention: 38 }],
	caption: 'week 1',
})

describe('CommentVisual', () => {
	it('dispatches a valid chart block to CommentChart', () => {
		render(<CommentVisual language="chart" source={validSpec} />)
		expect(screen.getByTestId('comment-chart')).toBeInTheDocument()
		expect(screen.getByText('week 1')).toBeInTheDocument()
	})

	it('renders the malformed-JSON fallback when source is not valid JSON', () => {
		render(<CommentVisual language="chart" source="{not json" />)
		const fallback = screen.getByTestId('comment-visual-fallback')
		expect(fallback.textContent).toMatch(/couldn't render chart/i)
		expect(screen.queryByTestId('comment-chart')).not.toBeInTheDocument()
	})

	it('renders the unsupported-spec fallback when type is unknown', () => {
		render(
			<CommentVisual
				language="chart"
				source={JSON.stringify({ type: 'pie', x: 'day', series: ['x'], data: [{}] })}
			/>,
		)
		const fallback = screen.getByTestId('comment-visual-fallback')
		expect(fallback.textContent).toMatch(/unsupported/i)
	})

	it('falls back to a code block for unknown languages', () => {
		render(<CommentVisual language="ruby" source={'puts "hi"'} />)
		expect(screen.queryByTestId('comment-visual-fallback')).not.toBeInTheDocument()
		expect(screen.queryByTestId('comment-chart')).not.toBeInTheDocument()
		const code = document.querySelector('code.language-ruby')
		expect(code?.textContent).toBe('puts "hi"')
	})
})
