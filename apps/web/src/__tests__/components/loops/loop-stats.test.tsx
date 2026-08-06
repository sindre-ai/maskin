import { LoopStats } from '@/components/loops/loop-stats'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildLoopSummary } from '../../factories'

describe('LoopStats', () => {
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
