import { LoopRow } from '@/components/loops/loop-row'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildActorListItem, buildLoopSummary } from '../../factories'

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
	return buildLoopSummary({
		id: 'loop-1',
		workspaceId: 'ws-1',
		name: 'Customer feedback',
		content: 'Every customer who gives feedback hears back within 30 days',
		status: 'supervised',
		pill: 'supervised',
		inProgressCount: 6,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		...overrides,
	})
}

function buildActor(overrides: Partial<ActorListItem> = {}): ActorListItem {
	return buildActorListItem({ id: 'actor-1', type: 'agent', name: 'Compass', ...overrides })
}

describe('LoopRow', () => {
	it('renders the name, one-line outcome, and the loop stage it is on', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		expect(screen.getByTestId('loop-pill')).toHaveTextContent('Supervised')
		expect(
			screen.getByText('Every customer who gives feedback hears back within 30 days'),
		).toBeInTheDocument()
		// v2 row: the outcome is truncated to one line, not clamped to two.
		expect(
			screen.getByText('Every customer who gives feedback hears back within 30 days').className,
		).toMatch(/truncate/)
	})

	it('stacks avatars for the loop agents that are working right now', () => {
		const actors = [
			buildActor({ id: 'a1', name: 'Compass' }),
			buildActor({ id: 'a2', name: 'Sentinel' }),
		]
		const loop = buildLoop({ agentIds: ['a1', 'a2'] })

		const { rerender } = render(<LoopRow loop={loop} actors={actors} />)
		expect(screen.queryByTitle('Working now')).not.toBeInTheDocument()

		rerender(<LoopRow loop={loop} actors={actors} busyAgentIds={new Set(['a1'])} />)
		expect(screen.getByTitle('Working now')).toBeInTheDocument()
	})

	it('renders "Waiting on you" pill when the loop is waiting', () => {
		render(<LoopRow loop={buildLoop({ pill: 'waiting_on_you' })} actors={[]} />)

		expect(screen.getByTestId('loop-pill')).toHaveTextContent('Waiting on you')
	})

	it('counts what is in flight while work is moving through the loop', () => {
		render(<LoopRow loop={buildLoop({ inProgressCount: 6, closedCount: 128 })} actors={[]} />)

		expect(screen.getByTestId('loop-stage')).toHaveTextContent('6 in progress')
	})

	it('falls back to what the loop has closed when nothing is in flight', () => {
		render(<LoopRow loop={buildLoop({ inProgressCount: 0, closedCount: 5 })} actors={[]} />)

		expect(screen.getByTestId('loop-stage')).toHaveTextContent('5 closed')
	})

	it('never prints a zero count on an idle loop', () => {
		render(<LoopRow loop={buildLoop({ inProgressCount: 0, closedCount: 0 })} actors={[]} />)

		expect(screen.getByTestId('loop-stage')).toHaveTextContent('Nothing in flight')
	})

	it('renders "Paused" as the stage when the loop is paused', () => {
		render(<LoopRow loop={buildLoop({ pill: 'paused', status: 'paused' })} actors={[]} />)

		expect(screen.getByTestId('loop-pill')).toHaveTextContent('Paused')
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

	it('links to the dedicated loop detail route, not the generic object page', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		const link = screen.getByRole('link')
		expect(link).toHaveAttribute('href', '/ws-1/loops/loop-1')
	})
})
