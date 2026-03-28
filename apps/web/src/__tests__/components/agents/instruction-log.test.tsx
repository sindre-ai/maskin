import { InstructionLog } from '@/components/agents/instruction-log'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockMutateAsync = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useCreateSession: () => ({
		mutateAsync: mockMutateAsync,
	}),
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'ank_test',
}))

vi.mock('@/lib/constants', () => ({
	API_BASE: '/api',
}))

vi.mock('@microsoft/fetch-event-source', () => ({
	fetchEventSource: vi.fn(),
}))

vi.mock('@/components/ui/spinner', () => ({
	Spinner: () => <span>spinner</span>,
}))

const agent = buildActorResponse({ id: 'agent-1', name: 'Scout', type: 'agent' })

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn()

describe('InstructionLog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders "Instruction Log" heading', () => {
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)
		expect(screen.getByText('Instruction Log')).toBeInTheDocument()
	})

	it('renders input with placeholder including agent name', () => {
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)
		expect(screen.getByPlaceholderText('Tell Scout what to do...')).toBeInTheDocument()
	})

	it('send button is disabled when input is empty', () => {
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)
		const sendButton = screen.getByRole('button')
		expect(sendButton).toBeDisabled()
	})

	it('send button is enabled when input has text', async () => {
		const user = userEvent.setup()
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		await user.type(screen.getByPlaceholderText('Tell Scout what to do...'), 'Check logs')
		const sendButton = screen.getByRole('button')
		expect(sendButton).toBeEnabled()
	})

	it('adds user message to chat on send', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		await user.type(screen.getByPlaceholderText('Tell Scout what to do...'), 'Check logs')
		await user.click(screen.getByRole('button'))

		expect(screen.getByText('Check logs')).toBeInTheDocument()
	})

	it('clears input after sending', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		const input = screen.getByPlaceholderText('Tell Scout what to do...')
		await user.type(input, 'Check logs')
		await user.click(screen.getByRole('button'))

		expect(input).toHaveValue('')
	})

	it('calls createSession.mutateAsync with agent id and prompt', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		await user.type(screen.getByPlaceholderText('Tell Scout what to do...'), 'Analyze metrics')
		await user.click(screen.getByRole('button'))

		expect(mockMutateAsync).toHaveBeenCalledWith({
			actor_id: 'agent-1',
			action_prompt: 'Analyze metrics',
		})
	})

	it('sends on Enter key without Shift', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		const input = screen.getByPlaceholderText('Tell Scout what to do...')
		await user.type(input, 'Run tests')
		await user.keyboard('{Enter}')

		expect(mockMutateAsync).toHaveBeenCalled()
	})

	it('does not send on Shift+Enter', async () => {
		const user = userEvent.setup()
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		const input = screen.getByPlaceholderText('Tell Scout what to do...')
		await user.type(input, 'Run tests')
		await user.keyboard('{Shift>}{Enter}{/Shift}')

		expect(mockMutateAsync).not.toHaveBeenCalled()
	})

	it('shows "Working on it..." with spinner for streaming agent message', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		await user.type(screen.getByPlaceholderText('Tell Scout what to do...'), 'Do work')
		await user.click(screen.getByRole('button'))

		await waitFor(() => {
			expect(screen.getByText('Working on it...')).toBeInTheDocument()
		})
	})

	it('shows "Failed to start session" when createSession rejects', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockRejectedValue(new Error('Server error'))
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		await user.type(screen.getByPlaceholderText('Tell Scout what to do...'), 'Do work')
		await user.click(screen.getByRole('button'))

		await waitFor(() => {
			expect(screen.getByText('Failed to start session')).toBeInTheDocument()
		})
	})

	it('disables input while streaming', async () => {
		const user = userEvent.setup()
		mockMutateAsync.mockResolvedValue({ id: 'session-1' })
		render(<InstructionLog agent={agent} workspaceId="ws-1" />)

		const input = screen.getByPlaceholderText('Tell Scout what to do...')
		await user.type(input, 'Do work')
		await user.click(screen.getByRole('button'))

		await waitFor(() => {
			expect(input).toBeDisabled()
		})
	})
})
