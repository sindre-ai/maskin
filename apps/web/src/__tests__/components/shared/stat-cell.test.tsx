import { SparkBar, StatCell } from '@/components/shared/stat-cell'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('StatCell', () => {
	it('renders the value and muted label', () => {
		render(<StatCell label="tokens used" value="1.2M" />)
		expect(screen.getByText('1.2M')).toBeInTheDocument()
		expect(screen.getByText('tokens used')).toBeInTheDocument()
	})

	it('applies the requested delta tone', () => {
		const { rerender } = render(
			<StatCell label="tokens" value="10" delta="+12%" deltaTone="positive" />,
		)
		expect(screen.getByText('+12%').className).toContain('text-success')
		rerender(<StatCell label="tokens" value="10" delta="-4%" deltaTone="negative" />)
		expect(screen.getByText('-4%').className).toContain('text-error')
	})

	it('renders an inline spark bar when a series is provided', () => {
		const { container } = render(<StatCell label="sessions" value="9" spark={[1, 2, 3]} />)
		expect(container.querySelector('[role="img"][aria-label="Spark bar"]')).toBeInTheDocument()
	})
})

describe('SparkBar', () => {
	it('renders one bar per data point scaled to the max', () => {
		const { container } = render(<SparkBar data={[10, 20]} />)
		const bars = [...(container.querySelector('[role="img"]')?.children ?? [])] as HTMLElement[]
		expect(bars).toHaveLength(2)
		expect(bars[0]?.style.height).toBe('50%')
		expect(bars[1]?.style.height).toBe('100%')
	})

	it('renders zero-height bars for an empty series', () => {
		const { container } = render(<SparkBar data={[0, 0]} />)
		const bars = [...(container.querySelector('[role="img"]')?.children ?? [])] as HTMLElement[]
		expect(bars[0]?.style.height).toBe('0%')
	})

	it('uses a token fill class by default', () => {
		const { container } = render(<SparkBar data={[5]} />)
		const bar = container.querySelector('[role="img"] span')
		expect(bar?.className).toContain('bg-primary')
	})
})
