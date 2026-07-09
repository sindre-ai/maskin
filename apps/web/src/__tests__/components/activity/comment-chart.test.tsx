import { CommentChart, parseChartSpec } from '@/components/activity/comment-chart'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// recharts depends on ResizeObserver + getBoundingClientRect dimensions; the
// jsdom defaults render the chart at 0×0 which collapses the SVG. Use the
// canonical 600×300 stand-in so assertions can target rendered geometry.
vi.mock('recharts', async () => {
	const actual = await vi.importActual<typeof import('recharts')>('recharts')
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
			<div data-testid="responsive-container" style={{ width: 600, height: 200 }}>
				{children}
			</div>
		),
	}
})

describe('parseChartSpec', () => {
	it('returns ok for a minimal valid bar spec', () => {
		const result = parseChartSpec(
			JSON.stringify({
				type: 'bar',
				x: 'day',
				series: ['retention'],
				data: [{ day: 'Mon', retention: 38 }],
				caption: 'week-1',
			}),
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.spec.type).toBe('bar')
			expect(result.spec.series).toEqual(['retention'])
		}
	})

	it('rejects invalid JSON', () => {
		const result = parseChartSpec('not json')
		expect(result.ok).toBe(false)
	})

	it('rejects unknown chart types', () => {
		const result = parseChartSpec(
			JSON.stringify({ type: 'pie', x: 'day', series: ['x'], data: [] }),
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toMatch(/unknown chart type/)
	})

	it('rejects a missing x field', () => {
		const result = parseChartSpec(JSON.stringify({ type: 'bar', series: ['x'], data: [] }))
		expect(result.ok).toBe(false)
	})

	it('rejects when series is empty', () => {
		const result = parseChartSpec(JSON.stringify({ type: 'bar', x: 'day', series: [], data: [] }))
		expect(result.ok).toBe(false)
	})
})

describe('CommentChart', () => {
	it('renders a caption when provided', () => {
		const { getByText } = render(
			<CommentChart
				spec={{
					type: 'bar',
					x: 'day',
					series: ['retention'],
					data: [{ day: 'Mon', retention: 38 }],
					caption: 'week-1 retention',
				}}
			/>,
		)
		expect(getByText('week-1 retention')).toBeInTheDocument()
	})
})
