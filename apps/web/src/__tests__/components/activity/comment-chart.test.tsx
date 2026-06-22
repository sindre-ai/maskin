import {
	CommentChart,
	type CommentChartSpec,
	parseChartSpec,
} from '@/components/activity/comment-chart'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// recharts uses ResponsiveContainer which needs measured width/height — the
// jsdom stub returns 0, which collapses the chart. Replace ResponsiveContainer
// with a fixed-size box so the BarChart actually mounts and the data-testid we
// rely on appears in the DOM.
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

describe('parseChartSpec', () => {
	it('accepts a minimal bar spec', () => {
		const spec = parseChartSpec({
			type: 'bar',
			x: 'day',
			series: ['retention'],
			data: [{ day: 'Mon', retention: 38 }],
		})
		expect(spec?.type).toBe('bar')
	})

	it('rejects when type is unknown', () => {
		expect(
			parseChartSpec({
				type: 'pie',
				x: 'day',
				series: ['retention'],
				data: [{ day: 'Mon', retention: 38 }],
			}),
		).toBeNull()
	})

	it('rejects when data is empty', () => {
		expect(parseChartSpec({ type: 'bar', x: 'day', series: ['retention'], data: [] })).toBeNull()
	})

	it('rejects when series is empty', () => {
		expect(parseChartSpec({ type: 'bar', x: 'day', series: [], data: [{ day: 'Mon' }] })).toBeNull()
	})

	it('rejects non-object input', () => {
		expect(parseChartSpec(null)).toBeNull()
		expect(parseChartSpec('chart')).toBeNull()
		expect(parseChartSpec(42)).toBeNull()
	})

	it('drops non-string series entries', () => {
		const spec = parseChartSpec({
			type: 'line',
			x: 'day',
			series: ['valid', 0, null],
			data: [{ day: 'Mon', valid: 1 }],
		})
		expect(spec?.series).toEqual(['valid'])
	})
})

describe('CommentChart', () => {
	const baseSpec: CommentChartSpec = {
		type: 'bar',
		x: 'day',
		series: ['retention'],
		data: [
			{ day: 'Mon', retention: 38 },
			{ day: 'Tue', retention: 42 },
		],
		caption: 'week-1 retention',
	}

	it('renders a chart figure with the right type attribute', () => {
		render(<CommentChart spec={baseSpec} />)
		const figure = screen.getByTestId('comment-chart')
		expect(figure.getAttribute('data-chart-type')).toBe('bar')
	})

	it('renders the caption when present', () => {
		render(<CommentChart spec={baseSpec} />)
		expect(screen.getByText('week-1 retention')).toBeInTheDocument()
	})

	it('renders without a caption when omitted', () => {
		const { caption: _drop, ...rest } = baseSpec
		render(<CommentChart spec={rest as CommentChartSpec} />)
		expect(screen.queryByText('week-1 retention')).not.toBeInTheDocument()
	})

	it('renders for line and area types without throwing', () => {
		render(<CommentChart spec={{ ...baseSpec, type: 'line' }} />)
		render(<CommentChart spec={{ ...baseSpec, type: 'area' }} />)
		const figures = screen.getAllByTestId('comment-chart')
		expect(figures.length).toBe(2)
		expect(figures[0].getAttribute('data-chart-type')).toBe('line')
		expect(figures[1].getAttribute('data-chart-type')).toBe('area')
	})
})
