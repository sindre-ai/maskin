import { LoopStats } from '@/components/loops/loop-stats'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildLoopSummary } from '../../factories'

describe('LoopStats (legacy 3-tile)', () => {
	it('renders in progress, closed, and median to close', () => {
		const loop = buildLoopSummary({
			inProgressCount: 6,
			closedCount: 128,
			medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		})
		render(<LoopStats loop={loop} />)

		expect(screen.getByText('6')).toBeInTheDocument()
		expect(screen.getByText('in progress')).toBeInTheDocument()
		expect(screen.getByText('128')).toBeInTheDocument()
		expect(screen.getByText('closed')).toBeInTheDocument()
		expect(screen.getByText('11d')).toBeInTheDocument()
		expect(screen.getByText('median to close')).toBeInTheDocument()
	})

	it('renders an em dash when there is no median yet', () => {
		render(<LoopStats loop={buildLoopSummary({ medianTimeToCloseMs: null })} />)

		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('does not render placeholder "ran alone" or "your time" stats', () => {
		render(<LoopStats loop={buildLoopSummary()} />)

		expect(screen.queryByText(/ran alone/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/your time/i)).not.toBeInTheDocument()
	})
})

describe('LoopStats (v4 5-tile)', () => {
	it('renders the five verbatim spec labels when the v4 props are provided', () => {
		render(
			<LoopStats
				loop={buildLoopSummary({
					pill: 'learning',
					closedCount: 128,
					medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
				})}
				cyclesRunning={6}
				asksWaiting={3}
				nextFire="in 4h"
			/>,
		)

		expect(screen.getByText('Cycles running')).toBeInTheDocument()
		expect(screen.getByText('Closed this month')).toBeInTheDocument()
		expect(screen.getByText('Median cycle time')).toBeInTheDocument()
		expect(screen.getByText('Asks waiting')).toBeInTheDocument()
		expect(screen.getByText('Next fire')).toBeInTheDocument()
		expect(screen.getByText('6')).toBeInTheDocument()
		expect(screen.getByText('128')).toBeInTheDocument()
		expect(screen.getByText('11d')).toBeInTheDocument()
		expect(screen.getByText('3')).toBeInTheDocument()
		expect(screen.getByText('in 4h')).toBeInTheDocument()
	})

	it('renders a pulsing dot next to Cycles running when the loop is live and the count is > 0', () => {
		const { container } = render(
			<LoopStats
				loop={buildLoopSummary({ pill: 'fully_autonomous' })}
				cyclesRunning={4}
				asksWaiting={0}
				nextFire={null}
			/>,
		)

		expect(container.querySelector('.animate-pulse')).not.toBeNull()
	})

	it('does not render the pulsing dot when cyclesRunning is zero, even on a live loop', () => {
		const { container } = render(
			<LoopStats
				loop={buildLoopSummary({ pill: 'learning' })}
				cyclesRunning={0}
				asksWaiting={0}
				nextFire={null}
			/>,
		)

		expect(container.querySelector('.animate-pulse')).toBeNull()
	})

	it('renders the Asks waiting tile in amber when the count is > 0', () => {
		render(
			<LoopStats loop={buildLoopSummary()} cyclesRunning={0} asksWaiting={2} nextFire={null} />,
		)

		const asksValue = screen.getByText('2')
		expect(asksValue.className).toContain('text-warning')
	})

	it('renders em-dash on the Next fire tile when no cron/reminder is scheduled', () => {
		render(
			<LoopStats loop={buildLoopSummary()} cyclesRunning={0} asksWaiting={0} nextFire={null} />,
		)

		const nextFireLabel = screen.getByText('Next fire')
		// The label sits directly below its value inside the tile div, so climbing
		// one parent finds the value cell for this specific tile.
		expect(nextFireLabel.parentElement?.textContent).toContain('—')
	})

	it('spans the Next fire tile across both columns at mobile (2×2 + full-width row)', () => {
		render(
			<LoopStats loop={buildLoopSummary()} cyclesRunning={0} asksWaiting={0} nextFire={null} />,
		)

		const nextFireLabel = screen.getByText('Next fire')
		const tile = nextFireLabel.parentElement
		expect(tile?.className).toContain('col-span-2')
		// ...and drops back to a single column starting at the sm breakpoint,
		// so the tablet layout wraps 3+2 rather than 3+1+1.
		expect(tile?.className).toContain('sm:col-span-1')
	})
})
