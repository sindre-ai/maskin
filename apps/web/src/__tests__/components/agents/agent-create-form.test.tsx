import { AgentCreateForm } from '@/components/agents/agent-create-form'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse } from '../../factories'

vi.mock('@/components/agents/mcp-servers', () => ({
	McpServers: ({ onUpdate }: { onUpdate: () => void }) => (
		<div onClick={onUpdate} onKeyDown={onUpdate} role="button" tabIndex={0} />
	),
}))

describe('AgentCreateForm', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders name textarea with placeholder', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} />)
		expect(screen.getByPlaceholderText('Agent name')).toBeInTheDocument()
	})

	it('renders system prompt textarea', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} />)
		expect(screen.getByPlaceholderText('Instructions for the agent...')).toBeInTheDocument()
	})

	it('renders model input with placeholder', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} />)
		expect(screen.getByPlaceholderText('e.g. claude-sonnet-4-5-20250514')).toBeInTheDocument()
	})

	it('shows "Creating..." when isPending is true', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} isPending />)
		expect(screen.getByText('Creating...')).toBeInTheDocument()
	})

	it('does not show "Creating..." when isPending is false', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} />)
		expect(screen.queryByText('Creating...')).not.toBeInTheDocument()
	})

	it('shows error message from error prop', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} error={new Error('Validation failed')} />)
		expect(screen.getByText('Validation failed')).toBeInTheDocument()
	})

	it('shows fallback error when error has no message', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} error={new Error('')} />)
		expect(screen.getByText('Failed to create agent')).toBeInTheDocument()
	})

	it('calls onAutoCreate when name first becomes valid', async () => {
		const user = userEvent.setup()
		const onAutoCreate = vi.fn()
		render(<AgentCreateForm onAutoCreate={onAutoCreate} />)

		await user.type(screen.getByPlaceholderText('Agent name'), 'Scout')
		expect(onAutoCreate).toHaveBeenCalledWith({ name: 'S' })
	})

	it('calls onAutoCreate only once even if name changes further', async () => {
		const user = userEvent.setup()
		const onAutoCreate = vi.fn()
		render(<AgentCreateForm onAutoCreate={onAutoCreate} />)

		await user.type(screen.getByPlaceholderText('Agent name'), 'Scout Agent')
		expect(onAutoCreate).toHaveBeenCalledTimes(1)
	})

	it('calls onUpdate with name on blur when typed name differs from agent name', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		const agent = buildActorResponse({ name: 'Old Name', type: 'agent' })
		render(<AgentCreateForm onAutoCreate={vi.fn()} onUpdate={onUpdate} agent={agent} />)

		const nameInput = screen.getByPlaceholderText('Agent name')
		await user.type(nameInput, 'New Name')
		await user.tab()

		expect(onUpdate).toHaveBeenCalledWith({ name: 'New Name' })
	})

	it('does not call onUpdate on blur when typed name matches agent name', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		const agent = buildActorResponse({ name: 'Scout', type: 'agent' })
		render(<AgentCreateForm onAutoCreate={vi.fn()} onUpdate={onUpdate} agent={agent} />)

		// Name starts empty in state, type same value as agent name so blur is a no-op
		const nameInput = screen.getByPlaceholderText('Agent name')
		await user.type(nameInput, 'Scout')
		await user.tab()

		// onUpdate should not have been called with name (only auto-create fires)
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it('calls onUpdate with system_prompt on blur when agent exists', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCreateForm onAutoCreate={vi.fn()} onUpdate={onUpdate} agent={agent} />)

		const promptInput = screen.getByPlaceholderText('Instructions for the agent...')
		await user.type(promptInput, 'Monitor alerts')
		await user.tab()

		expect(onUpdate).toHaveBeenCalledWith({ system_prompt: 'Monitor alerts' })
	})

	it('calls onUpdate with llm_config on model blur when agent exists', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCreateForm onAutoCreate={vi.fn()} onUpdate={onUpdate} agent={agent} />)

		const modelInput = screen.getByPlaceholderText('e.g. claude-sonnet-4-5-20250514')
		await user.type(modelInput, 'opus')
		await user.tab()

		expect(onUpdate).toHaveBeenCalledWith({ llm_config: { model: 'opus' } })
	})

	it('renders agent badge and idle status', () => {
		render(<AgentCreateForm onAutoCreate={vi.fn()} />)
		expect(screen.getByText('agent')).toBeInTheDocument()
		expect(screen.getByText('idle')).toBeInTheDocument()
	})
})
