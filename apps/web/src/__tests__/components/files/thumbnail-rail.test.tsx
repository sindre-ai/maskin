import { ThumbnailRail } from '@/components/files/thumbnail-rail'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ThumbnailRail', () => {
	it('renders one thumbnail per page', () => {
		render(<ThumbnailRail total={5} activeIndex={0} onSelect={() => {}} />)
		expect(screen.getAllByRole('tab')).toHaveLength(5)
		expect(screen.getByRole('tab', { name: 'Go to page 1 of 5' })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: 'Go to page 5 of 5' })).toBeInTheDocument()
	})

	it('marks the active thumbnail as selected', () => {
		render(<ThumbnailRail total={4} activeIndex={2} onSelect={() => {}} />)
		const active = screen.getByRole('tab', { name: 'Go to page 3 of 4' })
		expect(active).toHaveAttribute('aria-selected', 'true')
		expect(screen.getByRole('tab', { name: 'Go to page 1 of 4' })).toHaveAttribute(
			'aria-selected',
			'false',
		)
	})

	it('invokes onSelect with the zero-based page index when a thumbnail is clicked', async () => {
		const onSelect = vi.fn()
		render(<ThumbnailRail total={4} activeIndex={0} onSelect={onSelect} />)
		await userEvent.click(screen.getByRole('tab', { name: 'Go to page 3 of 4' }))
		expect(onSelect).toHaveBeenCalledWith(2)
	})

	it('renders nothing when total is zero', () => {
		render(<ThumbnailRail total={0} activeIndex={0} onSelect={() => {}} />)
		expect(screen.queryAllByRole('tab')).toHaveLength(0)
	})
})
