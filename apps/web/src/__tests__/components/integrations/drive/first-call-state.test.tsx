import { FirstCallState } from '@/components/integrations/drive/first-call-state'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const JTBD_TITLES = [
	'Read file bytes',
	'Read structured Docs',
	'Read Sheet ranges',
	'Search Drive',
	'Walk folder trees',
	'Watch a folder',
	'Write files',
	'Comment on a Doc',
]

describe('FirstCallState', () => {
	it('shows the headline and body', () => {
		render(<FirstCallState />)
		expect(
			screen.getByRole('heading', { name: 'Drive is connected. Point your agents at a file.' }),
		).toBeInTheDocument()
		expect(
			screen.getByText(/Your agents get the eight tools below the moment they need to/),
		).toBeInTheDocument()
	})

	it('renders the eight JTBD cards with verbatim titles', () => {
		render(<FirstCallState />)
		const cards = screen.getAllByTestId('drive-jtbd-card')
		expect(cards).toHaveLength(8)
		expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(JTBD_TITLES)
	})

	it('stacks to one column on mobile, two at md and up to four at xl', () => {
		render(<FirstCallState />)
		const grid = screen.getByTestId('drive-jtbd-grid')
		expect(grid).toHaveClass('grid-cols-1', 'md:grid-cols-2', 'xl:grid-cols-4')
	})

	it('labels the sample notification as a sample', () => {
		render(<FirstCallState />)
		const sample = screen.getByRole('region', {
			name: "Sample notification (what you'll see when it fires)",
		})
		expect(within(sample).getByTestId('drive-sample-notification')).toBeInTheDocument()
		expect(within(sample).getByText(/New recording landed in \/Meet Recordings/)).toBeVisible()
	})

	it('has no interactive controls: the sample buttons are not real buttons', () => {
		render(<FirstCallState />)
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('keeps decorative glyphs out of the accessibility tree', () => {
		render(<FirstCallState />)
		for (const card of screen.getAllByTestId('drive-jtbd-card')) {
			expect(card.querySelector('[aria-hidden="true"]')).not.toBeNull()
		}
	})
})
