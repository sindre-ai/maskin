import { ObjectEvidenceBlock } from '@/components/objects/object-evidence-block'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('ObjectEvidenceBlock', () => {
	it('renders quote behind a collapsible fold', async () => {
		const user = userEvent.setup()
		render(<ObjectEvidenceBlock evidence={{ quote: 'A source quote' }} />)

		// Collapsed by default — quote hidden
		expect(screen.queryByText('A source quote')).not.toBeInTheDocument()

		await user.click(screen.getByText('Evidence'))
		expect(screen.getByText('A source quote')).toBeInTheDocument()
	})

	it('renders source and date alongside the quote', async () => {
		const user = userEvent.setup()
		render(
			<ObjectEvidenceBlock
				evidence={{ quote: 'Q', source: 'Slack #general', date: '2026-08-01' }}
			/>,
		)
		await user.click(screen.getByText('Evidence'))
		expect(screen.getByText(/Slack #general/)).toBeInTheDocument()
		expect(screen.getByText(/2026-08-01/)).toBeInTheDocument()
	})

	it('omits the source/date line when none are present', async () => {
		const user = userEvent.setup()
		const { container } = render(<ObjectEvidenceBlock evidence={{ quote: 'Q' }} />)
		await user.click(screen.getByText('Evidence'))
		// Only the blockquote and the fold trigger remain
		expect(container.querySelectorAll('p').length).toBe(0)
	})
})
