import { AgentTriggersSection } from '@/components/agents/agent-triggers-section'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildTriggerResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const triggersData = vi.fn()

vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => ({ data: triggersData(), isLoading: false }),
}))

describe('AgentTriggersSection', () => {
	beforeEach(() => {
		triggersData.mockReset()
	})

	it('lists only the triggers that target this agent', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		triggersData.mockReturnValue([
			buildTriggerResponse({ id: 't1', name: 'Mine', targetActorId: 'agent-a' }),
			buildTriggerResponse({ id: 't2', name: 'Someone else', targetActorId: 'agent-b' }),
		])
		render(<AgentTriggersSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Mine')).toBeInTheDocument()
		expect(screen.queryByText('Someone else')).not.toBeInTheDocument()
	})

	it('shows an empty message when no trigger targets the agent', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		triggersData.mockReturnValue([buildTriggerResponse({ targetActorId: 'agent-b' })])
		render(<AgentTriggersSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText(/no triggers fire this agent/i)).toBeInTheDocument()
	})

	it('links each row to its trigger detail page', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		triggersData.mockReturnValue([
			buildTriggerResponse({ id: 't1', name: 'Nightly sweep', targetActorId: 'agent-a' }),
		])
		render(<AgentTriggersSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const link = screen.getByRole('link', { name: /open nightly sweep/i })
		expect(link).toHaveAttribute('href', '/$workspaceId/triggers/$triggerId')
	})

	it('collapses to three rows and expands on Show all', async () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		triggersData.mockReturnValue(
			['A', 'B', 'C', 'D', 'E'].map((n) =>
				buildTriggerResponse({ id: `t-${n}`, name: `Trigger ${n}`, targetActorId: 'agent-a' }),
			),
		)
		render(<AgentTriggersSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('link')).toHaveLength(3)
		await userEvent.click(screen.getByRole('button', { name: /show all 5/i }))
		expect(screen.getAllByRole('link')).toHaveLength(5)
		await userEvent.click(screen.getByRole('button', { name: /show fewer/i }))
		expect(screen.getAllByRole('link')).toHaveLength(3)
	})

	it('sorts enabled triggers before disabled ones', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		triggersData.mockReturnValue([
			buildTriggerResponse({
				id: 't1',
				name: 'Alpha off',
				targetActorId: 'agent-a',
				enabled: false,
			}),
			buildTriggerResponse({ id: 't2', name: 'Zulu on', targetActorId: 'agent-a', enabled: true }),
		])
		render(<AgentTriggersSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const links = screen.getAllByRole('link')
		expect(links[0]).toHaveAccessibleName(/zulu on/i)
		expect(links[1]).toHaveAccessibleName(/alpha off/i)
	})
})
