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

	it('renders the tile variant as a tinted square carrying the type glyph', () => {
		const { container } = render(<TypeBadge type="bet" variant="tile" />)
		const tile = container.firstElementChild as HTMLElement
		expect(tile.className).toContain('bg-type-bet-bg')
		expect(tile.className).toContain('size-[30px]')
		expect(tile.querySelector('svg')).toBeInTheDocument()
	})

	it('sizes the tile up for list rows and detail headers', () => {
		const { container } = render(<TypeBadge type="task" variant="tile" size="lg" />)
		expect((container.firstElementChild as HTMLElement).className).toContain('size-[38px]')
	})

	it('falls back to a neutral tile for an unknown extension type', () => {
		const { container } = render(<TypeBadge type="mystery" variant="tile" />)
		const tile = container.firstElementChild as HTMLElement
		expect(tile.className).toContain('bg-muted')
		expect(tile.querySelector('svg')).toBeNull()
	})
})
