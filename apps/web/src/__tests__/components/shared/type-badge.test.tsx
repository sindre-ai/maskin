import { TypeBadge } from '@/components/shared/type-badge'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('TypeBadge', () => {
	it('renders type text', () => {
		render(<TypeBadge type="insight" />)
		expect(screen.getByText('insight')).toBeInTheDocument()
	})

	it('renders different type text', () => {
		render(<TypeBadge type="task" />)
		expect(screen.getByText('task')).toBeInTheDocument()
	})

	it('renders the mono chip variant (compact uppercase type label)', () => {
		render(<TypeBadge type="bet" variant="mono" />)
		const chip = screen.getByText('bet')
		expect(chip).toBeInTheDocument()
		expect(chip.className).toContain('uppercase')
	})

	it('sticks to the badge pill variant by default', () => {
		render(<TypeBadge type="insight" />)
		const badge = screen.getByText('insight')
		expect(badge.className).not.toContain('uppercase')
	})
})
