import {
	AgentInstructionsEditModal,
	AgentInstructionsSection,
} from '@/components/agents/agent-instructions-section'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildTriggerResponse } from '../factories'
import { createWorkspaceWrapper } from '../setup'

vi.mock('@/hooks/use-actors', () => ({
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, to: _to, params: _params, ...rest }: Record<string, unknown>) => (
		<a href="/x" {...rest}>
			{children as React.ReactNode}
		</a>
	),
}))

const viewer = () => createWorkspaceWrapper({ role: 'viewer' })
const member = () => createWorkspaceWrapper({ role: 'member' })

const agent = buildActorResponse({
	id: 'agent-1',
	type: 'agent',
	name: 'Planner',
	system_prompt: 'You are Planner.',
})
const trigger = buildTriggerResponse({ name: 'Nightly sweep', enabled: true })

describe('viewer fixture: agent instructions and trigger toggle are disabled, not hidden', () => {
	it('disables the Edit button on the instructions section', () => {
		render(<AgentInstructionsSection agent={agent} />, { wrapper: viewer() })
		expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
	})

	it('switches off the instructions editor and Save', () => {
		render(<AgentInstructionsEditModal agent={agent} open onOpenChange={vi.fn()} />, {
			wrapper: viewer(),
		})
		expect(screen.getByRole('textbox', { name: 'System prompt' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
	})

	it('disables the trigger enable switch', () => {
		render(
			<TriggerRow
				trigger={trigger}
				workspaceId="ws-1"
				agentName="Planner"
				onToggleEnabled={vi.fn()}
			/>,
			{ wrapper: viewer() },
		)
		expect(screen.getByRole('switch', { name: 'Disable Nightly sweep' })).toBeDisabled()
	})

	it('does not call the toggle when a viewer clicks the switch', async () => {
		const onToggle = vi.fn()
		const user = userEvent.setup({ pointerEventsCheck: 0 })
		render(
			<TriggerRow
				trigger={trigger}
				workspaceId="ws-1"
				agentName="Planner"
				onToggleEnabled={onToggle}
			/>,
			{ wrapper: viewer() },
		)
		await user.click(screen.getByRole('switch', { name: 'Disable Nightly sweep' }))
		expect(onToggle).not.toHaveBeenCalled()
	})
})

describe('member fixture: nothing changes', () => {
	it('keeps Edit enabled and lets the editor save a changed prompt', async () => {
		const user = userEvent.setup()
		render(
			<>
				<AgentInstructionsSection agent={agent} />
				<AgentInstructionsEditModal agent={agent} open onOpenChange={vi.fn()} />
			</>,
			{ wrapper: member() },
		)
		// The open modal marks the rest of the page aria-hidden, so look the Edit button up with hidden: true.
		expect(screen.getByRole('button', { name: 'Edit', hidden: true })).toBeEnabled()
		const box = screen.getByRole('textbox', { name: 'System prompt' })
		expect(box).toBeEnabled()
		await user.type(box, ' More.')
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
	})

	it('keeps the trigger switch enabled and calls the toggle', async () => {
		const onToggle = vi.fn()
		const user = userEvent.setup()
		render(
			<TriggerRow
				trigger={trigger}
				workspaceId="ws-1"
				agentName="Planner"
				onToggleEnabled={onToggle}
			/>,
			{ wrapper: member() },
		)
		const toggle = screen.getByRole('switch', { name: 'Disable Nightly sweep' })
		expect(toggle).toBeEnabled()
		await user.click(toggle)
		expect(onToggle).toHaveBeenCalledWith(false)
	})
})
