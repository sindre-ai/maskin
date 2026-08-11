import { ObjectAskBanner } from '@/components/objects/object-ask-banner'
import { fireEvent, render, screen } from '@testing-library/react'

describe('ObjectAskBanner', () => {
	it('renders the open question and its sub text', () => {
		render(<ObjectAskBanner title="Which option wins?" sub="A or B?" onAnswer={vi.fn()} />)
		expect(screen.getByText('Which option wins?')).toBeInTheDocument()
		expect(screen.getByText('A or B?')).toBeInTheDocument()
	})

	it('omits the sub line when there is none', () => {
		render(<ObjectAskBanner title="Question?" sub={null} onAnswer={vi.fn()} />)
		expect(screen.getByText('Question?')).toBeInTheDocument()
		expect(screen.queryByText('A or B?')).not.toBeInTheDocument()
	})

	it('calls onAnswer when Answer it is clicked', () => {
		const onAnswer = vi.fn()
		render(<ObjectAskBanner title="Question?" sub={null} onAnswer={onAnswer} />)
		fireEvent.click(screen.getByRole('button', { name: /answer it/i }))
		expect(onAnswer).toHaveBeenCalledTimes(1)
	})
})
