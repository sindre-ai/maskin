import { PlanPercentProvider } from '@/components/billing/plan-percent-context'
import { LoopRow, loopProgress } from '@/components/loops/loop-row'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
		content: 'Every customer who gives feedback hears back within 30 days',
		status: 'learning',
		pill: 'learning',
		entryCondition: null,
		closeCondition: null,
		tags: [],
		driverId: null,
		inProgressCount: 6,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		waitingCount: 0,
		targets: null,
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
	it('renders the state dot, name, one-line outcome, and stage label', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		expect(screen.getByTestId('loop-pill')).toHaveTextContent('Learning')
		expect(
			screen.getByText('Every customer who gives feedback hears back within 30 days'),
		).toBeInTheDocument()
		// v2 row: the outcome is truncated to one line, not clamped to two.
		expect(
			screen.getByText('Every customer who gives feedback hears back within 30 days').className,
		).toMatch(/truncate/)
	})

	it('renders the green busy line only when agents on the loop are live', () => {
		const { rerender } = render(<LoopRow loop={buildLoop()} actors={[]} />)
		expect(screen.queryByText(/busy now/)).not.toBeInTheDocument()

		rerender(<LoopRow loop={buildLoop()} actors={[]} busyAgentCount={2} />)
		expect(screen.getByText('2 busy now')).toBeInTheDocument()
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

	it('renders "Waiting on you" as last activity when waiting on the viewer', () => {
		render(<LoopRow loop={buildLoop({ pill: 'waiting_on_you', inProgressCount: 0 })} actors={[]} />)

		// The stage pill carries the same words, so assert on the one that isn't it.
		const matches = screen.getAllByText('Waiting on you')
		expect(matches.some((el) => el.getAttribute('data-testid') !== 'loop-pill')).toBe(true)
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

	it('renders "Untitled flow" when name is null', () => {
		render(<LoopRow loop={buildLoop({ name: null })} actors={[]} />)

		expect(screen.getByText('Untitled flow')).toBeInTheDocument()
	})

	it('links to the dedicated loop detail route, not the generic object page', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)

		const link = screen.getByRole('link')
		expect(link).toHaveAttribute('href', '/ws-1/loops/loop-1')
	})

	describe('NO CREDITS pill', () => {
		it('renders the NO CREDITS overlay alongside PAUSED when the composite flag is on', () => {
			render(<LoopRow loop={buildLoop({ pill: 'paused' })} actors={[]} showNoCreditsPill />)

			// The PAUSED state label stays; NO CREDITS sits next to it.
			expect(screen.getByTestId('loop-pill')).toHaveTextContent('Paused')
			const overlay = screen.getByTestId('loop-pill-no-credits')
			expect(overlay).toBeInTheDocument()
			// The visible desktop copy is verbatim per SPEC; NO CR. is present but sm:hidden.
			expect(overlay.textContent).toContain('NO CREDITS')
			expect(overlay.textContent).toContain('NO CR.')
			// A11y — full state name announced regardless of viewport.
			expect(overlay).toHaveAttribute('aria-label', 'Paused — no credits')
		})

		it('reads Plan used up with the percent display on, and no top-up wording', () => {
			render(
				<PlanPercentProvider value>
					<LoopRow loop={buildLoop({ pill: 'paused' })} actors={[]} showNoCreditsPill />
				</PlanPercentProvider>,
			)

			const overlay = screen.getByTestId('loop-pill-no-credits')
			expect(overlay.textContent).toContain('Plan used up')
			expect(overlay.textContent).toContain('Used up')
			expect(overlay.textContent).not.toMatch(/NO CR/)
			expect(overlay).toHaveAttribute('aria-label', 'Paused. Your plan is used up.')
		})

		it('does not render the overlay when the composite flag is off', () => {
			render(<LoopRow loop={buildLoop({ pill: 'paused' })} actors={[]} />)

			expect(screen.queryByTestId('loop-pill-no-credits')).not.toBeInTheDocument()
		})

		it('does not render the overlay on a non-paused row even when the flag is on', () => {
			render(<LoopRow loop={buildLoop({ pill: 'learning' })} actors={[]} showNoCreditsPill />)

			expect(screen.queryByTestId('loop-pill-no-credits')).not.toBeInTheDocument()
		})

		it('fires onNoCreditsClick and swallows the row navigation on click', () => {
			const onClick = vi.fn()
			render(
				<LoopRow
					loop={buildLoop({ pill: 'paused' })}
					actors={[]}
					showNoCreditsPill
					onNoCreditsClick={onClick}
				/>,
			)

			const overlay = screen.getByTestId('loop-pill-no-credits')
			// Click should not propagate to the row Link — clicks bubble through
			// synthetic events, so this catches a missing stopPropagation.
			const clickEvent = fireEvent.click(overlay)
			expect(onClick).toHaveBeenCalledTimes(1)
			// fireEvent returns whether the default was allowed — false = preventDefault fired.
			expect(clickEvent).toBe(false)
		})
	})
})

describe('loopProgress', () => {
	const target = (actual: number, goal: number, label = 'customers closed') => ({
		source: 'manual',
		label,
		actual,
		target: goal,
	})

	it('is null for a flow without targets, so the row shows no progress line', () => {
		expect(loopProgress(buildLoop({ targets: null }))).toBeNull()
		expect(loopProgress(buildLoop({ targets: [] }))).toBeNull()
	})

	it('reads the first target as text and a percentage', () => {
		const progress = loopProgress(buildLoop({ targets: [target(3, 10)] }))
		expect(progress).toEqual({ text: '3 of 10 customers closed', percent: 30, missed: false })
	})

	it('calls a target with nothing done Missed, by the same rule as the target card', () => {
		const progress = loopProgress(buildLoop({ targets: [target(0, 10)] }))
		expect(progress?.missed).toBe(true)
		expect(progress?.percent).toBe(0)
	})

	it('caps the bar at full when the target is beaten', () => {
		const progress = loopProgress(buildLoop({ targets: [target(14, 10)] }))
		expect(progress?.percent).toBe(100)
	})
})

describe('LoopRow progress', () => {
	it('draws a labelled progress bar and a Missed chip for a missed target', () => {
		render(
			<LoopRow
				loop={buildLoop({
					targets: [{ source: 'manual', label: 'customers closed', actual: 0, target: 10 }],
				})}
				actors={[]}
			/>,
		)
		expect(
			screen.getByRole('progressbar', { name: '0 of 10 customers closed' }),
		).toBeInTheDocument()
		expect(screen.getByText('Missed')).toBeInTheDocument()
	})

	it('draws no progress bar when the flow has no target', () => {
		render(<LoopRow loop={buildLoop()} actors={[]} />)
		expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
		expect(screen.queryByText('Missed')).not.toBeInTheDocument()
	})
})
