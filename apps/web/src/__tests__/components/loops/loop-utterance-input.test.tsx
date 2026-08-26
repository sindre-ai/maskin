import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../../factories'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

// The real Composer reaches for the upload/query stack; this surface only cares
// that a submitted utterance is routed correctly.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		placeholder,
		textareaLabel,
	}: { onSend: (v: string) => Promise<void>; placeholder: string; textareaLabel?: string }) => (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				const input = (e.currentTarget as HTMLFormElement).elements.namedItem(
					'utterance',
				) as HTMLTextAreaElement
				void onSend(input.value)
			}}
		>
			<textarea name="utterance" aria-label={textareaLabel} placeholder={placeholder} />
			<button type="submit">Send</button>
		</form>
	),
}))

beforeEach(() => {
	navigateMock.mockClear()
})

describe('LoopUtteranceInput', () => {
	it('renders the "Listening — speak in plain words" placeholder', () => {
		render(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} />)

		expect(screen.getByPlaceholderText('Listening — speak in plain words')).toBeInTheDocument()
	})

	it('sticks to the bottom of the reader column', () => {
		const { container } = render(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} />)
		expect((container.firstChild as HTMLElement).className).toMatch(/sticky bottom-0/)
	})

	it('opens a new chat with the loop attached when nothing consumes the utterance', async () => {
		const user = userEvent.setup()
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })} />,
		)

		await user.type(
			screen.getByPlaceholderText('Listening — speak in plain words'),
			'Tighten the close timeline',
		)
		await user.click(screen.getByRole('button', { name: 'Send' }))

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
			search: { objectId: 'loop-1', objectTitle: 'Billing reliability', objectType: 'loop' },
		})
	})

	it('keeps the utterance in place when the page consumes it (proposed edit)', async () => {
		const user = userEvent.setup()
		const onUtterance = vi.fn(() => true)
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} onUtterance={onUtterance} />,
		)

		await user.type(screen.getByPlaceholderText('Listening — speak in plain words'), 'Close faster')
		await user.click(screen.getByRole('button', { name: 'Send' }))

		expect(onUtterance).toHaveBeenCalledWith('Close faster')
		expect(navigateMock).not.toHaveBeenCalled()
	})

	it('offers suggestion chips only when there is no change history yet', () => {
		const { rerender } = render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} showSuggestions />,
		)
		expect(screen.getByRole('button', { name: 'Close cycles faster' })).toBeInTheDocument()

		rerender(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} />)
		expect(screen.queryByRole('button', { name: 'Close cycles faster' })).not.toBeInTheDocument()
	})
})
