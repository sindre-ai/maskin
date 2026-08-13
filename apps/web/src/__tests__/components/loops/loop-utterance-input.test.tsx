import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../../factories'

const openWithContextMock = vi.fn()

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ openWithContext: openWithContextMock }),
}))

beforeEach(() => {
	openWithContextMock.mockClear()
})

describe('LoopUtteranceInput', () => {
	it('renders the "Listening — speak in plain words" placeholder', () => {
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })} />,
		)

		expect(screen.getByPlaceholderText('Listening — speak in plain words')).toBeInTheDocument()
	})

	it('forwards a plain-language utterance to the loop chat on submit', async () => {
		const user = userEvent.setup()
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })} />,
		)

		await user.type(
			screen.getByPlaceholderText('Listening — speak in plain words'),
			'Tighten the close timeline',
		)
		await user.keyboard('{Enter}')

		expect(openWithContextMock).toHaveBeenCalledWith(
			[{ kind: 'object', id: 'loop-1', title: 'Billing reliability', type: 'loop' }],
			'Tighten the close timeline',
		)
	})

	it('does not submit an empty utterance', async () => {
		const user = userEvent.setup()
		render(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} />)

		await user.keyboard('{Enter}')

		expect(openWithContextMock).not.toHaveBeenCalled()
	})

	it('calls onSubmit with the trimmed utterance when submitting', async () => {
		const user = userEvent.setup()
		const onSubmit = vi.fn()
		render(
			<LoopUtteranceInput
				loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })}
				onSubmit={onSubmit}
			/>,
		)

		await user.type(
			screen.getByPlaceholderText('Listening — speak in plain words'),
			'Tighten the close timeline',
		)
		await user.keyboard('{Enter}')

		expect(onSubmit).toHaveBeenCalledWith('Tighten the close timeline')
		// chat must also open
		expect(openWithContextMock).toHaveBeenCalledOnce()
	})

	it('does not call onSubmit for empty utterance', async () => {
		const user = userEvent.setup()
		const onSubmit = vi.fn()
		render(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} onSubmit={onSubmit} />)

		await user.keyboard('{Enter}')

		expect(onSubmit).not.toHaveBeenCalled()
	})
})
