import { ObjectEvidenceBlock } from '@/components/objects/object-evidence-block'
import { render, screen } from '@testing-library/react'

describe('ObjectEvidenceBlock', () => {
	it('renders the quote always visible', () => {
		render(<ObjectEvidenceBlock evidence={{ quote: 'A source quote' }} />)
		expect(screen.getByText('A source quote')).toBeInTheDocument()
	})

	it('renders source and date alongside the quote', () => {
		render(
			<ObjectEvidenceBlock
				evidence={{ quote: 'Q', source: 'Slack #general', date: '2026-08-01' }}
			/>,
		)
		expect(screen.getByText(/Slack #general/)).toBeInTheDocument()
		expect(screen.getByText(/2026-08-01/)).toBeInTheDocument()
	})

	it('omits the source/date line when none are present', () => {
		const { container } = render(<ObjectEvidenceBlock evidence={{ quote: 'Q' }} />)
		expect(container.querySelectorAll('p').length).toBe(0)
	})
})
