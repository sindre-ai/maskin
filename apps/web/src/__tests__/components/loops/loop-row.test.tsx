import { LoopRow } from '@/components/loops/loop-row'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				href = href.replace(`$${k}`, v)
			}
		}
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		)
	},
}))

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId: 'ws-1',
		name: 'Customer feedback',
		guarantee: 'Every customer who gives feedback hears back within 30 days',
		status: 'running',
		pill: 'running',
		entryCondition: null,
		closeCondition: null,
		humanDecisionPoints: null,
		inProgressCount: 6,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function buildActor(overrides: Partial<ActorListItem> = {}): ActorListItem {
	return {
		id: 'actor-1',
		type: 'agent',
		name: 'Compass',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'idle',
		...overrides,
	}
}

describe('LoopRow', () => {
	it('renders the running pill, name, guarantee, and stats', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(
			screen.getByText('Every customer who gives feedback hears back within 30 days'),
		).toBeInTheDocument()
		expect(screen.getByText('6 in progress')).toBeInTheDocument()
		expect(screen.getByText(/128 closed/)).toBeInTheDocument()
		expect(screen.getByText(/11d median/)).toBeInTheDocument()
	})

	it('renders "Waiting on you" pill when the loop is waiting', () => {
		render(<LoopRow loop={buildLoop({ pill: 'waiting_on_you' })} actors={[]} />)

		expect(screen.getByTestId('loop-pill')).toHaveTextContent('Waiting on you')
	})

	it('renders "X items in progress" as the last-activity line while work is active', () => {
		render(<LoopRow loop={buildLoop({ inProgressCount: 6, closedCount: 128 })} actors={[]} />)

		expect(screen.getByText('6 items in progress')).toBeInTheDocument()
	})

	it('renders "X items completed" as last activity when nothing is in progress', () => {
		render(<LoopRow loop={buildLoop({ inProgressCount: 0, closedCount: 5 })} actors={[]} />)

		expect(screen.getByText('5 items completed')).toBeInTheDocument()
	})

	it('renders "Paused — not running" as last activity when paused', () => {
		render(<LoopRow loop={buildLoop({ pill: 'paused' })} actors={[]} />)

		expect(screen.getByText('Paused — not running')).toBeInTheDocument()
	})

	it('renders the decision-point count in last activity when waiting on the viewer', () => {
		render(
			<LoopRow
				loop={buildLoop({ pill: 'waiting_on_you', humanDecisionPoints: 3, inProgressCount: 0 })}
				actors={[]}
			/>,
		)

		expect(screen.getByText('Waiting on you — 3 decision points open')).toBeInTheDocument()
	})

	it("renders the first agent's avatar next to the last-activity line", () => {
		const actors = [
			buildActor({ id: 'a1', name: 'Compass' }),
			buildActor({ id: 'a2', name: 'Sentinel' }),
		]
		render(
			<LoopRow loop={buildLoop({ agentIds: ['a1', 'a2'], inProgressCount: 2 })} actors={actors} />,
		)

		expect(screen.getByText('2 items in progress')).toBeInTheDocument()
		expect(screen.getAllByTitle('Compass').length).toBeGreaterThan(0)
	})

	it("renders agent avatars for the loop's agents (up to 5)", () => {
		const actors = [
			buildActor({ id: 'a1', name: 'Compass' }),
			buildActor({ id: 'a2', name: 'Sentinel' }),
		]
		const loop = buildLoop({ agentIds: ['a1', 'a2'] })
		render(<LoopRow loop={loop} actors={actors} />)

		expect(screen.getAllByTitle('Compass').length).toBeGreaterThan(0)
		expect(screen.getAllByTitle('Sentinel').length).toBeGreaterThan(0)
	})

	it('collapses agents past 5 into an overflow chip', () => {
		const actors = Array.from({ length: 7 }, (_, i) =>
			buildActor({ id: `a${i}`, name: `Agent${i}` }),
		)
		const loop = buildLoop({ agentIds: actors.map((a) => a.id) })
		render(<LoopRow loop={loop} actors={actors} />)

		expect(screen.getByText('+2')).toBeInTheDocument()
	})

	it('renders "Untitled loop" when name is null', () => {
		render(<LoopRow loop={buildLoop({ name: null })} actors={[]} />)

		expect(screen.getByText('Untitled loop')).toBeInTheDocument()
	})

	it('omits the median suffix when median is null', () => {
		render(<LoopRow loop={buildLoop({ medianTimeToCloseMs: null })} actors={[]} />)

		expect(screen.queryByText(/median/)).not.toBeInTheDocument()
	})

	it('links to the dedicated loop detail route, not the generic object page', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		const link = screen.getByRole('link')
		expect(link).toHaveAttribute('href', '/ws-1/loops/loop-1')
	})
})
