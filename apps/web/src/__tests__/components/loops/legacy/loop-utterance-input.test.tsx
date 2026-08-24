// Covers the pre-v2 component in `components/loops/legacy/`, rendered when the
// `new-design` flag is off. Dies with the flag.
import { LoopUtteranceInput } from '@/components/loops/legacy/loop-utterance-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../../../factories'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

beforeEach(() => {
	navigateMock.mockClear()
})

describe('LoopUtteranceInput', () => {
	it('renders the "Listening — speak in plain words" placeholder', () => {
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })} />,
		)

		expect(screen.getByPlaceholderText('Listening — speak in plain words')).toBeInTheDocument()
	})

	it('opens a new chat with the loop attached on submit', async () => {
		const user = userEvent.setup()
		render(
			<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1', name: 'Billing reliability' })} />,
		)

		await user.type(
			screen.getByPlaceholderText('Listening — speak in plain words'),
			'Tighten the close timeline',
		)
		await user.keyboard('{Enter}')

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
			search: { objectId: 'loop-1', objectTitle: 'Billing reliability', objectType: 'loop' },
		})
	})

	it('does not submit an empty utterance', async () => {
		const user = userEvent.setup()
		render(<LoopUtteranceInput loop={buildLoopSummary({ id: 'loop-1' })} />)

		await user.keyboard('{Enter}')

		expect(navigateMock).not.toHaveBeenCalled()
	})
})
