import { RelativeTime } from '@/components/shared/relative-time'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('RelativeTime', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns null when date is null', () => {
		const { container } = render(<RelativeTime date={null} />)
		expect(container.firstChild).toBeNull()
	})

	it('renders time element with dateTime attribute', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 5000)

		render(<RelativeTime date={date} />)
		const timeEl = screen.getByText('now').closest('time')
		expect(timeEl).toHaveAttribute('dateTime', date)
	})

	it('renders "now" for very recent dates', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 5000)

		render(<RelativeTime date={date} />)
		expect(screen.getByText('now')).toBeInTheDocument()
	})

	it('renders minutes ago for dates within the hour', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 15 * 60 * 1000)

		render(<RelativeTime date={date} />)
		expect(screen.getByText('15m ago')).toBeInTheDocument()
	})

	it('renders hours ago for dates within the day', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 3 * 60 * 60 * 1000)

		render(<RelativeTime date={date} />)
		expect(screen.getByText('3h ago')).toBeInTheDocument()
	})
	// Compact is the list-row age column (mockup 764): a fixed-width, right-aligned
	// cell, so the suffix is dropped and old dates collapse to a day/month token
	// instead of a full locale date that would wrap onto a second line.
	it('drops the "ago" suffix in compact mode', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 3 * 60 * 60 * 1000)

		render(<RelativeTime date={date} compact />)
		expect(screen.getByText('3h')).toBeInTheDocument()
	})

	it('renders a short day/month token in compact mode past a month', () => {
		const date = '2024-01-15T12:00:00Z'
		vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 60 * 24 * 60 * 60 * 1000)

		render(<RelativeTime date={date} compact />)
		expect(screen.getByText(/^(\w{3} \d+|\d+ \w{3})$/)).toBeInTheDocument()
	})
})
