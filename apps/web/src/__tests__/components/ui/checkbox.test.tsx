import { Checkbox } from '@/components/ui/checkbox'
import { render, screen } from '@testing-library/react'

describe('Checkbox', () => {
	it('renders the default sm size with no touch responsive classes', () => {
		render(<Checkbox aria-label="Default" />)
		const cb = screen.getByRole('checkbox', { name: 'Default' })
		expect(cb).toHaveAttribute('data-size', 'sm')
		expect(cb.className).toContain('h-4')
		expect(cb.className).toContain('w-4')
		expect(cb.className).not.toContain('max-[1024px]:h-11')
	})

	it('renders the touch size with ≥44px responsive classes at ≤1024px viewports (AC-T6)', () => {
		render(<Checkbox aria-label="Touch" size="touch" />)
		const cb = screen.getByRole('checkbox', { name: 'Touch' })
		expect(cb).toHaveAttribute('data-size', 'touch')
		expect(cb.className).toContain('max-[1024px]:h-11')
		expect(cb.className).toContain('max-[1024px]:w-11')
		// keeps the desktop fallback so >1024px stays at 16px
		expect(cb.className).toContain('h-4')
		expect(cb.className).toContain('w-4')
	})
})
