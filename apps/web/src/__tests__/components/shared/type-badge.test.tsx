import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TypeBadge } from '@/components/shared/type-badge'

describe('TypeBadge', () => {
	it('renders type text', () => {
		render(<TypeBadge type="insight" />)
		expect(screen.getByText('insight')).toBeInTheDocument()
	})

	it('renders different type text', () => {
		render(<TypeBadge type="task" />)
		expect(screen.getByText('task')).toBeInTheDocument()
	})
})
