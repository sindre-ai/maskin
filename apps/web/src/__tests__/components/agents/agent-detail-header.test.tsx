import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

// The Run / Pause control now lives in the nav row (mockup 2351) — it is
// published by AgentDetailView via `PageHeader actions`, not drawn here.
// Its behaviour is covered end-to-end in apps/e2e/src/tests/agent-detail.spec.ts.

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

	it('shows a running agent with a live status dot', () => {
		const agent = buildActorResponse({
			id: 'agent-run',
			type: 'agent',
			name: 'Runner',
			agentState: 'running',
		})
		const { container } = render(<AgentDetailHeader agent={agent} portrait="running" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(container.querySelector('.animate-pulse')).not.toBeNull()
	})

	it('does not pulse when the agent is idle', () => {
		const agent = buildActorResponse({ id: 'agent-idle', type: 'agent', name: 'Idler' })
		const { container } = render(<AgentDetailHeader agent={agent} portrait="idle" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(container.querySelector('.animate-pulse')).toBeNull()
	})
})
