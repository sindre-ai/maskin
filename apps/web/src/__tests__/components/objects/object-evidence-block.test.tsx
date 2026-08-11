import { ObjectEvidenceBlock } from '@/components/objects/object-evidence-block'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('ObjectEvidenceBlock', () => {
	it('hides the evidence behind the fold and reveals it on click', async () => {
		const user = userEvent.setup()
		render(<ObjectEvidenceBlock quote="The model is wrong." source="PR #123" date="2026-08-01" />)
		expect(screen.queryByText(/The model is wrong/)).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /evidence/i }))

		expect(screen.getByText('“The model is wrong.”')).toBeInTheDocument()
		expect(screen.getByText('PR #123')).toBeInTheDocument()
		expect(screen.getByText('2026-08-01')).toBeInTheDocument()
	})

	it('supports a custom fold label', () => {
		render(<ObjectEvidenceBlock quote="q" source="s" date={null} label="Backing" />)
		expect(screen.getByRole('button', { name: /backing/i })).toBeInTheDocument()
	})

	it('omits the date separator when no date is given', async () => {
		const user = userEvent.setup()
		render(<ObjectEvidenceBlock quote="q" source="s" date={null} />)

		await user.click(screen.getByRole('button', { name: /evidence/i }))

		expect(screen.getByText('s')).toBeInTheDocument()
		expect(screen.queryByText(/·/)).not.toBeInTheDocument()
	})
})
