import { ObjectEvidenceBlock } from '@/components/objects/object-evidence-block'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('ObjectEvidenceBlock', () => {
	it('renders the quote always visible', () => {
		render(<ObjectEvidenceBlock evidence={[{ quote: 'A source quote' }]} />)
		expect(screen.getByText(/A source quote/)).toBeInTheDocument()
	})

	it('renders source and date alongside the quote', () => {
		render(
			<ObjectEvidenceBlock
				evidence={[{ quote: 'Q', source: 'Slack #general', date: '2026-08-01' }]}
			/>,
		)
		expect(screen.getByText(/Slack #general/)).toBeInTheDocument()
		expect(screen.getByText(/2026-08-01/)).toBeInTheDocument()
	})

	it('omits the source/date line when none are present', () => {
		const { container } = render(<ObjectEvidenceBlock evidence={[{ quote: 'Q' }]} />)
		expect(container.querySelectorAll('p').length).toBe(0)
	})

	it('renders nothing when there is no evidence', () => {
		const { container } = render(<ObjectEvidenceBlock evidence={[]} />)
		expect(container).toBeEmptyDOMElement()
	})

	// Mockup 1127–1136: a wrapping row of quote cards plus a dashed "+N more".
	it('folds past the second quote and reveals the rest on click', async () => {
		const user = userEvent.setup()
		render(
			<ObjectEvidenceBlock
				evidence={[{ quote: 'First' }, { quote: 'Second' }, { quote: 'Third' }]}
			/>,
		)
		expect(screen.queryByText(/Third/)).toBeNull()
		await user.click(screen.getByRole('button', { name: '+1 more' }))
		expect(screen.getByText(/Third/)).toBeInTheDocument()
	})
})
