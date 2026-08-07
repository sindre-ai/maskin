import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarketplaceHeaderIdentity } from '@/components/marketplace/marketplace-header'

describe('MarketplaceHeaderIdentity', () => {
	it('shows the marketplace title and count', () => {
		render(<MarketplaceHeaderIdentity count={4} />)
		expect(screen.getByRole('heading', { name: 'Marketplace', level: 1 })).toBeInTheDocument()
		expect(screen.getByTestId('marketplace-count')).toHaveTextContent('4 in the marketplace')
	})

	it('omits the count when undefined', () => {
		render(<MarketplaceHeaderIdentity count={undefined} />)
		expect(screen.queryByTestId('marketplace-count')).not.toBeInTheDocument()
	})
})
