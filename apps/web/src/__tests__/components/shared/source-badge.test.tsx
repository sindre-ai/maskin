import { SourceBadge } from '@/components/shared/source-badge'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('SourceBadge', () => {
	it('renders the source text', () => {
		render(<SourceBadge source="behavioral" />)
		expect(screen.getByText('behavioral')).toBeInTheDocument()
	})

	it('applies a passed-in className', () => {
		const { container } = render(<SourceBadge source="behavioral" className="ml-2" />)
		expect(container.firstChild).toHaveClass('ml-2')
	})
})
