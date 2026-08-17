import { TriggerForm } from '@/components/triggers/trigger-form'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildTriggerResponse, buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const { useAutoSave } = vi.hoisted(() => {
	const useAutoSave = vi.fn()
	return { useAutoSave }
})

vi.mock('@/hooks/use-auto-save', () => ({
	useAutoSave: (args: unknown) => useAutoSave(args),
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

vi.mock('@maskin/module-sdk', () => ({
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
		useAutoSave.mockReturnValue({ showSaved: false })
	})

	it('renders trigger name input with placeholder', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByPlaceholderText('Trigger name')).toBeInTheDocument()
	})

	it('renders type cards (event, cron, reminder) as focusable radios', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByRole('radio', { name: /Event/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /Schedule/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /Reminder/i })).toBeInTheDocument()
	})

	it('shows every trigger section: When it fires and Do this', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(screen.getByRole('heading', { name: 'When it fires' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Do this' })).toBeInTheDocument()
	})

	it('pins a plain-language summary that re-renders live on config edits', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		const summary = screen.getByText('What happens').closest('section')
		expect(summary).not.toBeNull()

		await user.click(screen.getByRole('radio', { name: /Reminder/i }))
		const dateInput = document.querySelector('input[type="date"]')
		expect(dateInput).not.toBeNull()
		fireEvent.change(dateInput as HTMLInputElement, { target: { value: '2026-09-01' } })

		await waitFor(() => {
			expect(summary?.textContent).toContain('2026-09-01')
		})
	})

	it('updates the section description text in place when the type changes', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		expect(screen.getByText(/Fires when something happens/i)).toBeInTheDocument()

		await user.click(screen.getByRole('radio', { name: /Schedule/i }))

		expect(screen.getByText(/Fires on a recurring schedule/i)).toBeInTheDocument()
		expect(screen.queryByText(/Fires when something happens/i)).not.toBeInTheDocument()
	})

	it('shows the Saved indicator only when autosave reports a completed save', () => {
		render(<TriggerForm {...defaultProps} isCreated />, { wrapper: TestWrapper })
		const savedDefault = screen.getByText('Saved')
		expect(savedDefault.className).toMatch(/opacity-0/)
	})

	it('shows the Saved indicator when autosave reports a completed save', () => {
		useAutoSave.mockReturnValue({ showSaved: true })
		render(<TriggerForm {...defaultProps} isCreated />, { wrapper: TestWrapper })
		const saved = screen.getByText('Saved')
		expect(saved.className).toMatch(/opacity-100/)
	})

	it('keeps a sticky bottom save bar with "editing" meta for created triggers', () => {
		render(<TriggerForm {...defaultProps} isCreated />, { wrapper: TestWrapper })
		const bar = screen.getByText('Editing — every change saves automatically').parentElement
			?.parentElement
		expect(bar?.className).toMatch(/sticky bottom-0/)
		expect(screen.getByText('Saved')).toBeInTheDocument()
	})

	it('gives radios a 44px touch target on mobile and collapses to one column', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		const eventRadio = screen.getByRole('radio', { name: /Event/i })
		expect(eventRadio.closest('label')?.className).toMatch(/min-h-11/)

		await user.click(screen.getByRole('radio', { name: /Reminder/i }))
		const controls = document.querySelectorAll('input[type="date"], input[type="time"]')
		for (const control of controls) {
			expect((control as HTMLInputElement).className).toMatch(/min-h-11/)
		}

		const container = document.querySelector('input[type="date"]')?.parentElement
		expect(container?.className).toMatch(/flex-col/)
		expect(container?.className).toMatch(/sm:flex-row/)
	})

	it('type cards are keyboard-reachable and operable with Space', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		const scheduleRadio = screen.getByRole('radio', { name: /Schedule/i })
		scheduleRadio.focus()
		expect(document.activeElement).toBe(scheduleRadio)

		await user.keyboard(' ')

		expect(screen.getByText(/Fires on a recurring schedule/i)).toBeInTheDocument()
	})

	it('announces the summary region to assistive tech via aria-live', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		const summary = screen.getByText('What happens').closest('section')
		expect(summary?.getAttribute('aria-live')).toBe('polite')
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

		await user.click(screen.getByRole('radio', { name: /Schedule/i }))

		expect(screen.getByRole('button', { name: 'Hourly' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Weekly' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument()
	})

	it('reminder type shows date and time inputs', async () => {
		const user = userEvent.setup()
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('radio', { name: /Reminder/i }))

		const dateInput = document.querySelector('input[type="date"]')
		const timeInput = document.querySelector('input[type="time"]')
		expect(dateInput).toBeInTheDocument()
		expect(timeInput).toBeInTheDocument()
	})

	it('shows prompt textarea', () => {
		render(<TriggerForm {...defaultProps} />, { wrapper: TestWrapper })
		expect(
			screen.getByPlaceholderText('Describe what the agent should do when this trigger fires...'),
		).toBeInTheDocument()
	})

	it('shows enabled/disabled toggle for created triggers and flips on click', async () => {
		const user = userEvent.setup()
		const onToggleEnabled = vi.fn()
		render(<TriggerForm {...defaultProps} isCreated onToggleEnabled={onToggleEnabled} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Enabled')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Disable' }))

		expect(onToggleEnabled).toHaveBeenCalledTimes(1)
		expect(screen.getByText('Disabled')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
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

		render(<TriggerForm {...defaultProps} initialValues={trigger} isCreated />, {
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

	it('stacks the status-transition row on mobile breakpoints', async () => {
		const user = userEvent.setup()
		const workspaceWithStatuses = buildWorkspaceWithRole({
			settings: { statuses: { insight: ['new', 'reviewed', 'done'] } },
		})

		render(<TriggerForm {...defaultProps} workspace={workspaceWithStatuses} />, {
			wrapper: TestWrapper,
		})

		// The default trigger is event/created — switch action to status_changed
		// to reveal the transition row. The action select is the second combobox.
		const comboboxes = screen.getAllByRole('combobox')
		await user.click(comboboxes[1])
		await user.click(screen.getByRole('option', { name: 'status_changed' }))

		const transitionLabel = screen.getByText('Status transition')
		const transitionRow = transitionLabel.parentElement?.querySelector('div')
		expect(transitionRow?.className).toMatch(/flex-col/)
		expect(transitionRow?.className).toMatch(/sm:flex-row/)
	})

	it('calls onAutoCreate when form becomes valid', async () => {
		const user = userEvent.setup()
		const onAutoCreate = vi.fn()

		render(<TriggerForm {...defaultProps} onAutoCreate={onAutoCreate} />, {
			wrapper: TestWrapper,
		})

		await user.type(screen.getByPlaceholderText('Trigger name'), 'New trigger')
		await user.type(
			screen.getByPlaceholderText('Describe what the agent should do when this trigger fires...'),
			'Run analysis',
		)

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
