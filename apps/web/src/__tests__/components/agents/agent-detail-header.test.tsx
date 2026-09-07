import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

// The Run / Pause control now lives in the nav row (mockup 2351) — it is
// published by AgentDetailView via `PageHeader actions`, not drawn here.
// Its behaviour is covered in agent-detail-view.test.tsx.

const updateMutate = vi.fn()

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useUpdateActor: () => ({ mutate: updateMutate, isPending: false }),
}))

beforeEach(() => {
	updateMutate.mockReset()
})

describe('AgentDetailHeader', () => {
	it('renders name, status pill, team, and "Owns one outcome" line', () => {
		const agent = buildActorResponse({
			id: 'agent-1',
			type: 'agent',
			name: 'Planner',
			description: 'Shapes the next bet',
			agentState: 'idle',
		})
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper({ name: 'Product Team' }),
		})
		expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument()
		expect(screen.getByText(/Owns one outcome:/)).toBeInTheDocument()
		expect(screen.getByText('Shapes the next bet')).toBeInTheDocument()
		expect(screen.getByText('Product Team')).toBeInTheDocument()
		expect(screen.getByText('Idle')).toBeInTheDocument()
	})

	it('falls back when the agent has no description', () => {
		const agent = buildActorResponse({ name: 'Unclaimed', description: null, type: 'agent' })
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(screen.getByText('No outcome set yet')).toBeInTheDocument()
	})

	// v2 dropped the dot and the plate here — the identity row is one line of
	// text, so the status is the coloured word alone (mockup 2321).
	it('states a running agent as a bare coloured word, with no dot or plate', () => {
		const agent = buildActorResponse({
			id: 'agent-run',
			type: 'agent',
			name: 'Runner',
			agentState: 'running',
		})
		const { container } = render(<AgentDetailHeader agent={agent} portrait="running" />, {
			wrapper: createWorkspaceWrapper(),
		})
		const status = screen.getByText('Running')
		expect(status.className).toContain('text-status-in_progress-text')
		expect(status.className).not.toContain('bg-status-in_progress-bg')
		expect(container.querySelector('.animate-pulse')).toBeNull()
	})

	it('does not pulse when the agent is idle', () => {
		const agent = buildActorResponse({ id: 'agent-idle', type: 'agent', name: 'Idler' })
		const { container } = render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(container.querySelector('.animate-pulse')).toBeNull()
	})

	it('saves a renamed agent when the inline name field is committed', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-edit', type: 'agent', name: 'Planner' })
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Edit agent name' }))
		const input = screen.getByRole('textbox', { name: 'Agent name' })
		await user.clear(input)
		await user.type(input, 'Strategist{Enter}')

		expect(updateMutate).toHaveBeenCalledWith(
			{ id: 'agent-edit', data: { name: 'Strategist' } },
			expect.anything(),
		)
	})

	it('saves the outcome when the inline description field is committed', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({
			id: 'agent-out',
			type: 'agent',
			name: 'Planner',
			description: null,
		})
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Edit outcome' }))
		await user.type(screen.getByRole('textbox', { name: 'Outcome' }), 'Ships the weekly bet{Enter}')

		expect(updateMutate).toHaveBeenCalledWith(
			{ id: 'agent-out', data: { description: 'Ships the weekly bet' } },
			expect.anything(),
		)
	})

	it('discards the draft on Escape without saving', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-esc', type: 'agent', name: 'Planner' })
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(screen.getByRole('button', { name: 'Edit agent name' }))
		await user.type(screen.getByRole('textbox', { name: 'Agent name' }), 'zzz{Escape}')

		expect(updateMutate).not.toHaveBeenCalled()
		expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument()
	})

	it('keeps a loop-managed agent read-only', () => {
		const agent = buildActorResponse({
			id: 'agent-managed',
			type: 'agent',
			name: 'Managed',
			installedLoopId: '11111111-1111-4111-8111-111111111111',
		})
		render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(screen.queryByRole('button', { name: 'Edit agent name' })).toBeNull()
	})
})
