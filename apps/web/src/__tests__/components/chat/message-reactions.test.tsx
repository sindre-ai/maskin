import { ReactButton, ReactionChips } from '@/components/chat/message-reactions'
import type { MessageReaction } from '@/lib/api'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

function reaction(overrides: Partial<MessageReaction> = {}): MessageReaction {
	return {
		emoji: '👍',
		count: 2,
		reactedByMe: false,
		actors: [
			{ actorId: 'magnus', actorName: 'Magnus' },
			{ actorId: 'rune', actorName: 'Rune' },
		],
		...overrides,
	}
}

describe('ReactButton', () => {
	it('opens a picker of the five quick emoji', () => {
		render(<ReactButton reactions={[]} onToggle={vi.fn()} />)
		expect(screen.queryByRole('button', { name: 'React with 👍' })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }))
		for (const emoji of ['👍', '❤️', '😂', '✅', '👀']) {
			expect(screen.getByRole('button', { name: `React with ${emoji}` })).toBeInTheDocument()
		}
	})

	it('reports the picked emoji and closes the picker', () => {
		const onToggle = vi.fn()
		render(<ReactButton reactions={[]} onToggle={onToggle} />)
		fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }))
		fireEvent.click(screen.getByRole('button', { name: 'React with ❤️' }))
		expect(onToggle).toHaveBeenCalledWith('❤️')
		expect(screen.queryByRole('button', { name: 'React with ❤️' })).not.toBeInTheDocument()
	})

	it('shows an emoji you already used as pressed, and offers to take it back', () => {
		render(<ReactButton reactions={[reaction({ reactedByMe: true })]} onToggle={vi.fn()} />)
		fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }))
		expect(screen.getByRole('button', { name: 'Take back 👍' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		expect(screen.getByRole('button', { name: 'React with ❤️' })).toHaveAttribute(
			'aria-pressed',
			'false',
		)
	})

	it('is switched off for a viewer', () => {
		render(<ReactButton reactions={[]} onToggle={vi.fn()} disabled />)
		expect(screen.getByRole('button', { name: 'Add reaction' })).toBeDisabled()
	})
})

describe('ReactionChips', () => {
	it('draws nothing when there are no reactions', () => {
		const { container } = render(<ReactionChips reactions={[]} meId="me" onToggle={vi.fn()} />)
		expect(container).toBeEmptyDOMElement()
	})

	it('draws one chip per emoji with its count', () => {
		render(
			<ReactionChips
				reactions={[reaction(), reaction({ emoji: '👀', count: 1 })]}
				meId="me"
				onToggle={vi.fn()}
			/>,
		)
		expect(screen.getAllByRole('button')).toHaveLength(2)
		expect(screen.getByText('2')).toBeInTheDocument()
		expect(screen.getByText('1')).toBeInTheDocument()
	})

	it('names who reacted for screen readers and marks your own as pressed', () => {
		render(
			<ReactionChips
				reactions={[
					reaction({
						reactedByMe: true,
						actors: [
							{ actorId: 'magnus', actorName: 'Magnus' },
							{ actorId: 'me', actorName: 'Me' },
						],
					}),
				]}
				meId="me"
				onToggle={vi.fn()}
			/>,
		)
		const chip = screen.getByRole('button', { name: /You and Magnus reacted with 👍/ })
		expect(chip).toHaveAttribute('aria-pressed', 'true')
		expect(chip).toHaveAccessibleName(/Press to take it back/)
	})

	it('adds or takes back your reaction when a chip is pressed', () => {
		const onToggle = vi.fn()
		render(<ReactionChips reactions={[reaction()]} meId="me" onToggle={onToggle} />)
		fireEvent.click(screen.getByRole('button', { name: /reacted with 👍/ }))
		expect(onToggle).toHaveBeenCalledWith('👍')
	})

	it('is switched off for a viewer', () => {
		render(<ReactionChips reactions={[reaction()]} meId="me" onToggle={vi.fn()} disabled />)
		expect(screen.getByRole('button', { name: /reacted with 👍/ })).toBeDisabled()
	})
})
