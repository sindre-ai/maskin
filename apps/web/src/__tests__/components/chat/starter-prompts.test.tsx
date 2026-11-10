import { StarterPrompts } from '@/components/chat/starter-prompts'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('StarterPrompts', () => {
	it('renders one button per prompt, with the prompt as its name', () => {
		render(<StarterPrompts prompts={['What needs me today?', 'Summarise']} onPick={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'What needs me today?' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Summarise' })).toBeInTheDocument()
	})

	it('hands the exact prompt to onPick on a tap, and does nothing else', () => {
		const onPick = vi.fn()
		render(<StarterPrompts prompts={['What needs me today?']} onPick={onPick} />)
		fireEvent.click(screen.getByRole('button', { name: 'What needs me today?' }))
		expect(onPick).toHaveBeenCalledTimes(1)
		expect(onPick).toHaveBeenCalledWith('What needs me today?')
	})

	it('is not a submit button, so a tap inside a form never sends it', () => {
		render(
			<form>
				<StarterPrompts prompts={['Hi']} onPick={vi.fn()} />
			</form>,
		)
		expect(screen.getByRole('button', { name: 'Hi' })).toHaveAttribute('type', 'button')
	})

	it('renders nothing for an agent with no prompts', () => {
		const { container } = render(<StarterPrompts prompts={[]} onPick={vi.fn()} />)
		expect(container).toBeEmptyDOMElement()
	})
})
