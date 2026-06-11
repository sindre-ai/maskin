import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildActorListItem, buildObjectResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockMutate = vi.fn()
const mockMutateImpl = (
	_args: { actor_id: string; action_prompt: string },
	opts?: {
		onSuccess?: (result: ReturnType<typeof buildSessionResponse>) => void
		onError?: (err: Error) => void
	},
) => {
	opts?.onSuccess?.(buildSessionResponse({ id: 'session-1' }))
}

const mockNavigate = vi.fn(() => Promise.resolve())

vi.mock('@tanstack/react-router', async () => {
	const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
		'@tanstack/react-router',
	)
	return {
		...actual,
		useNavigate: () => mockNavigate,
	}
})

const mockActors = [
	buildActorListItem({ id: 'agent-1', name: 'Builder', type: 'agent' }),
	buildActorListItem({ id: 'agent-2', name: 'Reviewer', type: 'agent' }),
	buildActorListItem({ id: 'human-1', name: 'Alice', type: 'human' }),
	buildActorListItem({ id: 'system-1', name: 'System', type: 'agent', isSystem: true }),
]

const mockBets = [
	buildObjectResponse({ id: 'bet-1', type: 'bet', title: 'Bet One', status: 'active' }),
	buildObjectResponse({ id: 'bet-closed', type: 'bet', title: 'Bet Old', status: 'closed' }),
]

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: mockActors }),
}))

vi.mock('@/hooks/use-bets', () => ({
	useBets: () => ({ data: mockBets }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useCreateSession: () => ({ mutate: mockMutate, isPending: false }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn() }),
}))

import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'

const noop = () => {}

function renderComposer(open = true, onOpenChange: (open: boolean) => void = noop) {
	return render(
		<NewConversationComposer workspaceId="ws-1" open={open} onOpenChange={onOpenChange} />,
		{ wrapper: TestWrapper },
	)
}

describe('NewConversationComposer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMutate.mockImplementation(mockMutateImpl)
	})

	it('does not render content when closed', () => {
		renderComposer(false)
		expect(screen.queryByText('New conversation')).not.toBeInTheDocument()
	})

	it('renders title and description when open', () => {
		renderComposer(true)
		expect(screen.getByText('New conversation')).toBeInTheDocument()
		expect(screen.getByPlaceholderText(/what do you want the agent/i)).toBeInTheDocument()
	})

	it('disables submit until an agent and message are present', async () => {
		const user = userEvent.setup()
		renderComposer(true)
		const submit = screen.getByRole('button', { name: /start conversation/i })
		expect(submit).toBeDisabled()
		await user.type(screen.getByPlaceholderText(/what do you want the agent/i), 'hello')
		// agent still unset — still disabled
		expect(submit).toBeDisabled()
	})

	it('shows only non-system agent actors in the agent picker', async () => {
		renderComposer(true)
		const trigger = screen.getByLabelText('Agent')
		await userEvent.setup().click(trigger)
		expect(await screen.findByRole('option', { name: 'Builder' })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: 'Reviewer' })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: 'Alice' })).not.toBeInTheDocument()
		expect(screen.queryByRole('option', { name: 'System' })).not.toBeInTheDocument()
	})

	it('excludes closed bets from the bet picker', async () => {
		renderComposer(true)
		const trigger = screen.getByLabelText('Bet')
		await userEvent.setup().click(trigger)
		expect(await screen.findByRole('option', { name: 'Bet One' })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: 'Bet Old' })).not.toBeInTheDocument()
	})

	it('submits with actor_id and message, then closes', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		renderComposer(true, onOpenChange)

		await user.click(screen.getByLabelText('Agent'))
		await user.click(await screen.findByRole('option', { name: 'Builder' }))
		await user.type(screen.getByPlaceholderText(/what do you want the agent/i), 'do thing')
		await user.click(screen.getByRole('button', { name: /start conversation/i }))

		expect(mockMutate).toHaveBeenCalledWith(
			{ actor_id: 'agent-1', action_prompt: 'do thing' },
			expect.anything(),
		)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('prefixes action_prompt with bet context when a bet is selected', async () => {
		const user = userEvent.setup()
		renderComposer(true)

		await user.click(screen.getByLabelText('Agent'))
		await user.click(await screen.findByRole('option', { name: 'Builder' }))
		await user.click(screen.getByLabelText('Bet'))
		await user.click(await screen.findByRole('option', { name: 'Bet One' }))
		await user.type(screen.getByPlaceholderText(/what do you want the agent/i), 'do thing')
		await user.click(screen.getByRole('button', { name: /start conversation/i }))

		expect(mockMutate).toHaveBeenCalledTimes(1)
		const [args] = mockMutate.mock.calls[0]
		expect(args.actor_id).toBe('agent-1')
		expect(args.action_prompt).toContain('Bet One')
		expect(args.action_prompt).toContain('bet-1')
		expect(args.action_prompt).toContain('do thing')
	})

	it('navigates to the agent session after successful submit', async () => {
		const user = userEvent.setup()
		renderComposer(true)

		await user.click(screen.getByLabelText('Agent'))
		await user.click(await screen.findByRole('option', { name: 'Builder' }))
		await user.type(screen.getByPlaceholderText(/what do you want the agent/i), 'hi')
		await user.click(screen.getByRole('button', { name: /start conversation/i }))

		expect(mockNavigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/agents/$agentId',
				params: { workspaceId: 'ws-1', agentId: 'agent-1' },
			}),
		)
	})

	it('cancel button closes without submitting', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		renderComposer(true, onOpenChange)
		await user.click(screen.getByRole('button', { name: /cancel/i }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(mockMutate).not.toHaveBeenCalled()
	})

	it('trims whitespace-only message and stays disabled', async () => {
		const user = userEvent.setup()
		renderComposer(true)
		await user.click(screen.getByLabelText('Agent'))
		await user.click(await screen.findByRole('option', { name: 'Builder' }))
		await user.type(screen.getByPlaceholderText(/what do you want the agent/i), '   ')
		expect(screen.getByRole('button', { name: /start conversation/i })).toBeDisabled()
	})
})
