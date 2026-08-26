import { ObjectAskBanner } from '@/components/objects/object-ask-banner'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('ObjectAskBanner', () => {
	it('renders the open question', () => {
		render(<ObjectAskBanner question="Should we ship this?" onAnswerClick={vi.fn()} />)
		expect(screen.getByText('Open question')).toBeInTheDocument()
		expect(screen.getByText('Should we ship this?')).toBeInTheDocument()
	})

	it('calls onAnswerClick when Answer it is clicked', async () => {
		const user = userEvent.setup()
		const onAnswerClick = vi.fn()
		render(<ObjectAskBanner question="Question?" onAnswerClick={onAnswerClick} />)

		await user.click(screen.getByRole('button', { name: /answer it/i }))
		expect(onAnswerClick).toHaveBeenCalledTimes(1)
	})
})
