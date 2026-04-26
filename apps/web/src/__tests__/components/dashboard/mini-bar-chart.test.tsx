import { MiniBarChart } from '@/components/dashboard/mini-bar-chart'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function getInnerBars(container: HTMLElement) {
	return container.querySelectorAll<HTMLDivElement>('[role="img"] > div > div')
}

describe('MiniBarChart', () => {
	it('renders a bar per data item with widths proportional to the max value', () => {
		const { container } = render(
			<MiniBarChart
				data={[
					{ label: 'A', value: 10 },
					{ label: 'B', value: 5 },
					{ label: 'C', value: 0 },
				]}
				height={40}
			/>,
		)

		const outerBars = container.querySelectorAll<HTMLDivElement>('[role="img"] > div')
		expect(outerBars).toHaveLength(3)
		expect(outerBars[0]).toHaveAttribute('title', 'A: 10')
		expect(outerBars[1]).toHaveAttribute('title', 'B: 5')
		expect(outerBars[2]).toHaveAttribute('title', 'C: 0')

		const innerBars = container.querySelectorAll<HTMLDivElement>('[role="img"] > div > div')
		expect(innerBars[0].style.height).toBe('100%')
		expect(innerBars[1].style.height).toBe('50%')
		expect(innerBars[2].style.height).toBe('0%')
	})

	it('renders an empty chart when data is empty', () => {
		render(<MiniBarChart data={[]} ariaLabel="empty test" />)
		const chart = screen.getByRole('img', { name: /empty test \(empty\)/i })
		expect(chart.children.length).toBe(0)
	})

	it('renders stacked segments inside a single bar', () => {
		const { container } = render(
			<MiniBarChart
				data={[
					{
						label: 'mix',
						segments: [
							{ value: 3, label: 'a' },
							{ value: 1, label: 'b' },
						],
					},
				]}
				height={40}
			/>,
		)

		const outerBar = container.querySelector<HTMLDivElement>('[role="img"] > div > div')
		expect(outerBar).not.toBeNull()
		const segs = outerBar?.querySelectorAll<HTMLDivElement>('div') ?? []
		expect(segs).toHaveLength(2)
		expect(segs[0].style.height).toBe('75%')
		expect(segs[1].style.height).toBe('25%')
		expect(segs[0]).toHaveAttribute('aria-label', 'a')
		expect(segs[1]).toHaveAttribute('aria-label', 'b')
	})

	it('uses the custom format function in the bar tooltip', () => {
		const { container } = render(
			<MiniBarChart
				data={[{ label: 'cost', value: 1234 }]}
				formatValue={(n) => `$${n.toLocaleString()}`}
			/>,
		)
		const outerBar = container.querySelector<HTMLDivElement>('[role="img"] > div')
		expect(outerBar).toHaveAttribute('title', 'cost: $1,234')
	})

	it('treats negative values as zero so heights stay non-negative', () => {
		const { container } = render(
			<MiniBarChart
				data={[
					{ label: 'neg', value: -5 },
					{ label: 'pos', value: 10 },
				]}
			/>,
		)
		const innerBars = getInnerBars(container)
		expect(innerBars[0].style.height).toBe('0%')
		expect(innerBars[1].style.height).toBe('100%')
	})

	it('exposes the provided ariaLabel on the chart', () => {
		render(<MiniBarChart data={[{ label: 'A', value: 1 }]} ariaLabel="burn rate" />)
		expect(screen.getByRole('img', { name: 'burn rate' })).toBeInTheDocument()
	})
})
