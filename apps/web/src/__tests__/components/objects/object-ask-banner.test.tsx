import { ObjectAskBanner } from '@/components/objects/object-ask-banner'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('ObjectAskBanner', () => {
	// The lead and the question run together on one line, so the lead is
	// matched as a prefix rather than as its own text node.
	it('renders the open question', () => {
		render(<ObjectAskBanner question="Should we ship this?" onAnswerClick={vi.fn()} />)
		expect(screen.getByText(/Open question/)).toBeInTheDocument()
		expect(screen.getByText(/Should we ship this\?/)).toBeInTheDocument()
	})

	it('calls onAnswerClick when Answer it is clicked', async () => {
		const user = userEvent.setup()
		const onAnswerClick = vi.fn()
		render(<ObjectAskBanner question="Question?" onAnswerClick={onAnswerClick} />)

		await user.click(screen.getByRole('button', { name: /answer it/i }))
		expect(onAnswerClick).toHaveBeenCalledTimes(1)
	})

	describe('line variant', () => {
		it('reads "<name> asks:" with the question and an Answer button', async () => {
			const user = userEvent.setup()
			const onAnswerClick = vi.fn()
			render(
				<ObjectAskBanner
					variant="line"
					question="Save straight away?"
					actorName="Strategist"
					onAnswerClick={onAnswerClick}
				/>,
			)
			expect(screen.getByText('Strategist asks:')).toBeInTheDocument()
			expect(screen.getByText('Save straight away?')).toBeInTheDocument()
			await user.click(screen.getByRole('button', { name: 'Answer' }))
			expect(onAnswerClick).toHaveBeenCalledTimes(1)
		})
	})

	describe('when the question is cut off', () => {
		// scrollWidth and clientWidth live on Element.prototype, so there is no own
		// descriptor on HTMLElement.prototype: the stub is removed again, not restored.
		const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
		const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
		beforeEach(() => {
			Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
				configurable: true,
				get: () => 500,
			})
			Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
				configurable: true,
				get: () => 100,
			})
		})
		afterEach(() => {
			if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
			else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
			if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
			else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
		})

		it('expands the full text in place and collapses it again', async () => {
			const user = userEvent.setup()
			render(<ObjectAskBanner question="A long welcome message" onAnswerClick={vi.fn()} />)

			const text = screen.getByText(/A long welcome message/)
			expect(text).toHaveClass('truncate')

			await user.click(screen.getByRole('button', { name: 'Show all' }))
			expect(text).not.toHaveClass('truncate')
			expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
				'aria-expanded',
				'true',
			)

			await user.click(screen.getByRole('button', { name: 'Show less' }))
			expect(text).toHaveClass('truncate')
		})
	})

	it('shows no Show all toggle when the question fits', () => {
		render(<ObjectAskBanner question="Short?" onAnswerClick={vi.fn()} />)
		expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument()
	})
})
