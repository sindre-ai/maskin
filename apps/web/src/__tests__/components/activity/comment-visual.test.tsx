import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { render } from '@testing-library/react'
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

describe('isVisualLanguage', () => {
	it('recognises chart', () => {
		expect(isVisualLanguage('chart')).toBe(true)
	})
	it('rejects unrelated languages', () => {
		expect(isVisualLanguage('js')).toBe(false)
		expect(isVisualLanguage(undefined)).toBe(false)
	})
})

describe('CommentVisual', () => {
	const validChart = JSON.stringify({
		type: 'bar',
		x: 'day',
		series: ['v'],
		data: [{ day: 'Mon', v: 1 }],
		caption: 'ok',
	})

	it('renders a chart for chart language', () => {
		const { getByText } = render(<CommentVisual language="chart" source={validChart} />)
		expect(getByText('ok')).toBeInTheDocument()
	})

	it('falls back without throwing when JSON is malformed', () => {
		const { getByText } = render(<CommentVisual language="chart" source="{not json" />)
		expect(getByText(/Couldn’t render chart/)).toBeInTheDocument()
	})

	it('falls back when required fields are missing', () => {
		const { getByText } = render(
			<CommentVisual language="chart" source={JSON.stringify({ type: 'bar' })} />,
		)
		expect(getByText(/Couldn’t render chart/)).toBeInTheDocument()
	})

	it('falls back for unsupported visual languages', () => {
		const { getByText } = render(<CommentVisual language="mermaid" source="graph TD; A-->B;" />)
		expect(getByText(/Couldn’t render chart/)).toBeInTheDocument()
	})
})
