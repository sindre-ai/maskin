import { TargetsAndOwners } from '@/components/loops/targets-and-owners'
import type { ActorListItem, LoopSummary } from '@maskin/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId: 'ws-1',
		name: 'Weekly demand',
		content: null,
		status: 'learning',
		pill: 'learning',
		entryCondition: null,
		closeCondition: null,
		inProgressCount: 0,
		closedCount: 0,
		medianTimeToCloseMs: null,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		targets: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

const OWNER: ActorListItem = {
	id: OWNER_ID,
	name: 'Sebk',
	type: 'human',
	// biome-ignore lint/suspicious/noExplicitAny: unused fields on the row
} as any

describe('TargetsAndOwners', () => {
	it('renders nothing when the loop has null targets', () => {
		const { container } = render(<TargetsAndOwners loop={buildLoop()} actors={[OWNER]} />)
		expect(container.firstChild).toBeNull()
	})

	it('renders nothing when the loop has an empty targets array', () => {
		const { container } = render(
			<TargetsAndOwners loop={buildLoop({ targets: [] })} actors={[OWNER]} />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders the section header + one card per target when the loop has at least one target', () => {
		render(
			<TargetsAndOwners
				loop={buildLoop({
					targets: [
						{
							label: 'Posts published',
							source: 'posts published this month',
							actual: 6,
							target: 8,
							ownerActorId: OWNER_ID,
						},
						{
							label: 'LinkedIn impressions',
							source: 'metric:linkedin.impressions',
							actual: 4200,
							target: 5000,
						},
					],
				})}
				actors={[OWNER]}
			/>,
		)
		expect(screen.getByLabelText('Targets and owners')).toBeInTheDocument()
		expect(screen.getByText('Posts published')).toBeInTheDocument()
		expect(screen.getByText('LinkedIn impressions')).toBeInTheDocument()
		// One `Above target` pill (6/8 -> on target at 0.75 = behind pace default;
		// stronger to check specific pace verdicts below rather than here).
	})

	it('derives pace verdicts on render — never reads a persisted pace field', () => {
		render(
			<TargetsAndOwners
				loop={buildLoop({
					targets: [
						// Ratio 1.0 exactly — Above target
						{ label: 'Row A', source: 'plain', actual: 10, target: 10 },
						// Ratio 0.95 with default policy (window ≥ 0.9) — On target
						{ label: 'Row B', source: 'plain', actual: 95, target: 100 },
						// Ratio 0.5 — Behind pace
						{ label: 'Row C', source: 'plain', actual: 5, target: 10 },
						// actual = 0 with a positive target — Missed pace verdict
						{ label: 'Row D', source: 'plain', actual: 0, target: 10 },
					],
				})}
				actors={[]}
			/>,
		)
		expect(screen.getByText('Above target')).toBeInTheDocument()
		expect(screen.getByText('On target')).toBeInTheDocument()
		expect(screen.getByText('Behind pace')).toBeInTheDocument()
		expect(screen.getByText('Missed')).toBeInTheDocument()
	})

	it('honours pace_policy: strict — 0.95 reads Behind pace, not On target', () => {
		render(
			<TargetsAndOwners
				loop={buildLoop({
					targets: [
						{
							label: 'Strict target',
							source: 'plain',
							actual: 95,
							target: 100,
							pace_policy: 'strict',
						},
					],
				})}
				actors={[]}
			/>,
		)
		expect(screen.getByText('Behind pace')).toBeInTheDocument()
		expect(screen.queryByText('On target')).not.toBeInTheDocument()
	})

	it('renders each target card with the label, actual/target numbers, and pace pill', () => {
		render(
			<TargetsAndOwners
				loop={buildLoop({
					targets: [
						{
							label: 'Posts published',
							source: 'plain',
							actual: 6,
							target: 8,
							ownerActorId: OWNER_ID,
						},
					],
				})}
				actors={[OWNER]}
			/>,
		)
		expect(screen.getByText('Posts published')).toBeInTheDocument()
		expect(screen.getByText('6')).toBeInTheDocument()
		expect(screen.getByText('/ 8')).toBeInTheDocument()
		expect(screen.getByLabelText('Behind pace — 6 of 8')).toBeInTheDocument()
	})
})
