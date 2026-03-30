import { TriggerForm } from '@/components/triggers/trigger-form'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildTriggerResponse, buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-auto-save', () => ({
	useAutoSave: () => ({ showSaved: false }),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => ['work'],
}))

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: [] }),
	useProviders: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => [],
}))

vi.mock('@ai-native/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [
		{ value: 'insight', label: 'Insights' },
		{ value: 'bet', label: 'Bets' },
	],
	getAllWebModules: () => [
		{
			id: 'work',
			name: 'Work',
			objectTypeTabs: [
				{ value: 'insight', label: 'Insights' },
				{ value: 'bet', label: 'Bets' },
			],
		},
	],
}))

describe('TriggerForm', () => {
	const workspace = buildWorkspaceWithRole({ settings: {} })
	const agents = [
		{ id: 'agent-1', name: 'Scout' },
		{ id: 'agent-2', name: 'Analyst' },
	]
	const defaultProps = {
		workspaceId: 'ws-1',
		workspace,
		agents,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders trigger name input with placeholder', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByPlaceholderText('Trigger name')).toBeInTheDocument()
	})

	it('renders type buttons (event, cron, reminder)', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByRole('button', { name: 'event' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'cron' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'reminder' })).toBeInTheDocument()
	})

	it('shows warning when agents array is empty', () => {
		render(<TriggerForm {...defaultProps} agents={[]} />, { wrapper: TestWrapper })
		expect(
			screen.getByText('No agents available. Create an agent first before setting up triggers.'),
		).toBeInTheDocument()
	})

	it('shows agent selector when agents provided', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByText('Scout')).toBeInTheDocument()
	})

	it('event type shows entity type and action selects', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		// Default type is 'event', should show entity type values
		expect(screen.getByText('Insights')).toBeInTheDocument()
		expect(screen.getByText('created')).toBeInTheDocument()
	})

	it('cron type shows frequency buttons', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'cron' }))

		expect(screen.getByRole('button', { name: 'Hourly' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Weekly' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument()
	})

	it('reminder type shows date and time inputs', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'reminder' }))

		const dateInput = document.querySelector('input[type="date"]')
		const timeInput = document.querySelector('input[type="time"]')
		expect(dateInput).toBeInTheDocument()
		expect(timeInput).toBeInTheDocument()
	})

	it('shows prompt textarea', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByPlaceholderText('Action prompt for the agent...')).toBeInTheDocument()
	})

	it('shows enabled/disabled toggle', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByText('Enabled')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument()
	})

	it('pre-fills form when initialValues provided', () => {
		const trigger = buildTriggerResponse({
			name: 'My Trigger',
			type: 'cron',
			config: { expression: '0 9 * * *' },
			actionPrompt: 'Do the thing',
			targetActorId: 'agent-1',
			enabled: false,
		})

		render(<TriggerForm {...defaultProps} initialValues={trigger} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByDisplayValue('My Trigger')).toBeInTheDocument()
		expect(screen.getByDisplayValue('Do the thing')).toBeInTheDocument()
		expect(screen.getByText('Disabled')).toBeInTheDocument()
	})

	it('shows error message when error prop set', () => {
		render(<TriggerForm {...defaultProps} error={new Error('Something broke')} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Something broke')).toBeInTheDocument()
	})

	it('calls onAutoCreate when form becomes valid', async () => {
		const user = userEvent.setup()
		const onAutoCreate = vi.fn()

		render(<TriggerForm {...defaultProps} onAutoCreate={onAutoCreate} />, {
			wrapper: TestWrapper,
		})

		await user.type(screen.getByPlaceholderText('Trigger name'), 'New trigger')
		await user.type(screen.getByPlaceholderText('Action prompt for the agent...'), 'Run analysis')

		expect(onAutoCreate).toHaveBeenCalledTimes(1)
		expect(onAutoCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				name: expect.any(String),
				type: 'event',
				action_prompt: expect.any(String),
				target_actor_id: 'agent-1',
			}),
		)
	})
})
