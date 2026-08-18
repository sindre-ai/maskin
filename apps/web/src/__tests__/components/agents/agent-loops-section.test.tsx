import { AgentLoopsSection } from '@/components/agents/agent-loops-section'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildActorResponse, buildLoopSummary } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		[key: string]: unknown
	}) => {
		let href = to
		for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v)
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		)
	},
}))

const listLoops = vi.fn()
const listActors = vi.fn()

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			loops: { ...actual.api.loops, list: (...args: unknown[]) => listLoops(...args) },
			actors: { ...actual.api.actors, list: (...args: unknown[]) => listActors(...args) },
		},
	}
})

const agent = () => buildActorResponse({ id: 'agent-1', type: 'agent', name: 'Scout' })

describe('AgentLoopsSection', () => {
	beforeEach(() => {
		listLoops.mockReset()
		listActors.mockReset()
		listActors.mockResolvedValue([buildActorListItem({ id: 'agent-1', name: 'Scout' })])
	})

	it('renders one row per loop the agent runs and links it to the loop', async () => {
		listLoops.mockResolvedValue({
			loops: [
				buildLoopSummary({ id: 'loop-mine', name: 'Feedback loop', agentIds: ['agent-1'] }),
				buildLoopSummary({ id: 'loop-other', name: 'Someone else', agentIds: ['agent-2'] }),
			],
		})

		render(<AgentLoopsSection agent={agent()} />, { wrapper: createWorkspaceWrapper() })

		expect(await screen.findByText('Feedback loop')).toBeInTheDocument()
		expect(screen.queryByText('Someone else')).not.toBeInTheDocument()
		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		expect(screen.getByRole('link')).toHaveAttribute('href', '/ws-1/loops/loop-mine')
	})

	it('shows the section heading with a count', async () => {
		listLoops.mockResolvedValue({
			loops: [
				buildLoopSummary({ id: 'l1', name: 'One', agentIds: ['agent-1'] }),
				buildLoopSummary({ id: 'l2', name: 'Two', agentIds: ['agent-1'] }),
			],
		})

		render(<AgentLoopsSection agent={agent()} />, { wrapper: createWorkspaceWrapper() })

		expect(
			await screen.findByRole('heading', { name: 'Loops it runs', level: 2 }),
		).toBeInTheDocument()
		expect(await screen.findByText('One')).toBeInTheDocument()
		expect(screen.getByText('2')).toBeInTheDocument()
	})

	it('shows an empty state when the agent runs no loops', async () => {
		listLoops.mockResolvedValue({
			loops: [buildLoopSummary({ id: 'loop-other', agentIds: ['agent-2'] })],
		})

		render(<AgentLoopsSection agent={agent()} />, { wrapper: createWorkspaceWrapper() })

		expect(await screen.findByText('Not tied to a loop yet')).toBeInTheDocument()
		expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
	})
})
