import type { LoopStep, LoopSummary, TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLoopStep, buildLoopSummary } from '../factories'

// Tanstack router — the route file calls `createFileRoute` at module top; the
// mock keeps the returned options shape so the component under test can be
// pulled off `Route.component`, matching `loops-index.test.tsx`.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => ({ loopId: 'loop-1' }),
		}),
	}
})

const mockUseLoops = vi.fn()
const mockUseLoopSteps = vi.fn()
const mockUseLoopActivity = vi.fn()
vi.mock('@/hooks/use-loops', () => ({
	useLoop: (id: string) => {
		const loops = mockUseLoops() as { data?: LoopSummary[] }
		return { data: loops.data?.find((l) => l.id === id), isLoading: false, isError: false }
	},
	useLoops: () => mockUseLoops(),
	useLoopSteps: () => mockUseLoopSteps(),
	useLoopActivity: () => mockUseLoopActivity(),
}))

const mockUseActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

const mockUseTriggers = vi.fn()
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => mockUseTriggers(),
}))

const mockUseRelationships = vi.fn()
vi.mock('@/hooks/use-relationships', () => ({
	useRelationships: () => mockUseRelationships(),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({ data: undefined }),
	useObjects: () => ({ data: [] }),
	useUpdateObject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

const mockUseFeatureFlag = vi.fn()
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => mockUseFeatureFlag(id),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))

const trackAskBannerDecideClicked = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackAskBannerDecideClicked: (payload: unknown) => trackAskBannerDecideClicked(payload),
}))

// Layout + heavy child components are irrelevant to the AskBanner wiring
// assertions; stub them so the route renders without their real dependencies.
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: () => null,
}))
vi.mock('@/components/loops/loop-flow', () => ({
	LoopFlow: () => null,
}))
vi.mock('@/components/loops/loop-first-run-banner', () => ({
	LoopFirstRunBanner: () => null,
}))
vi.mock('@/components/loops/loop-utterance-input', () => ({
	LoopUtteranceInput: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/loops/loop-stats', () => ({
	LoopStats: () => null,
}))
vi.mock('@/components/loops/targets-and-owners', () => ({
	TargetsAndOwners: () => null,
}))
vi.mock('@/components/loops/loop-proposed-edit', () => ({
	LoopProposedEdit: () => null,
	diffLoopPlans: () => [],
	readStoredPlan: () => null,
}))
vi.mock('@/components/loops/loop-pill', () => ({
	LOOP_PILL_STYLES: {
		learning: { label: 'Learning', text: '', dot: '' },
		supervised: { label: 'Supervised', text: '', dot: '' },
		fully_autonomous: { label: 'Fully autonomous', text: '', dot: '' },
		paused: { label: 'Paused', text: '', dot: '' },
		draft: { label: 'Draft', text: '', dot: '' },
		waiting_on_you: { label: 'Waiting on you', text: '', dot: '' },
	},
	isLiveLoopPill: () => true,
}))
vi.mock('@/components/objects/object-detail-body', () => ({
	ObjectDetailBody: () => null,
}))
vi.mock('@/components/objects/timeline-tab', () => ({
	TimelineTab: () => null,
}))
vi.mock('@/components/shared/editable-title', () => ({
	EditableTitle: () => null,
}))

import { Route } from '@/routes/_authed/$workspaceId/loops/$loopId'

const LoopDetailRoute = (Route as unknown as { component: React.FC }).component

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't-fallback',
		workspaceId: 'ws-1',
		name: 'Fallback trigger',
		type: 'cron',
		targetActorId: 'actor-fallback',
		config: { expression: '0 * * * *' },
		actionPrompt: 'Fallback trigger action prompt',
		enabled: true,
		createdBy: 'actor-fallback',
		createdAt: null,
		updatedAt: null,
	} as TriggerResponse
}

const FLAG_UMBRELLA = 'loops-v4-polish'
const FLAG_STEP_FLOW = 'loops-v4-polish.step_flow'

function setFlags(state: { umbrella: boolean; stepFlow: boolean }) {
	mockUseFeatureFlag.mockImplementation((id: string) => {
		if (id === FLAG_UMBRELLA) return state.umbrella
		if (id === FLAG_STEP_FLOW) return state.stepFlow
		return false
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mockUseLoopActivity.mockReturnValue({ data: [] })
	mockUseTriggers.mockReturnValue({ data: [] })
	mockUseActors.mockReturnValue({ data: [] })
	mockUseRelationships.mockReturnValue({ data: [] })
	mockUseLoopSteps.mockReturnValue({ data: [] })
	setFlags({ umbrella: false, stepFlow: false })
})

describe('LoopDetailRoute — AskBanner wiring', () => {
	it('samples the first pending step for agentName + askText when step_flow is on', () => {
		setFlags({ umbrella: true, stepFlow: true })
		const loop = buildLoopSummary({
			id: 'loop-1',
			name: 'Deal pipeline',
			// Loop-level waitingOnViewer is deliberately false — the banner has to
			// derive its visibility and copy from the per-step feed, not this bit.
			waitingOnViewer: false,
			waitingCount: 0,
			agentIds: ['actor-first-agent'],
			triggerIds: ['t-not-pending', 't-pending'],
		})
		mockUseLoops.mockReturnValue({ data: [loop] })
		mockUseActors.mockReturnValue({
			data: [
				{
					id: 'actor-first-agent',
					name: 'First agent',
					type: 'agent',
					email: null,
					description: null,
					isSystem: false,
					agentState: 'idle',
				},
			],
		})
		// Trigger's action prompt is the OLD fallback — the wiring must NOT
		// surface it when a real pending step exists.
		mockUseTriggers.mockReturnValue({
			data: [
				buildTrigger({
					id: 't-not-pending',
					targetActorId: 'actor-first-agent',
					actionPrompt: 'DO NOT USE THIS COPY — fallback trigger prompt',
					enabled: true,
				}),
				buildTrigger({
					id: 't-pending',
					targetActorId: 'actor-pending',
					actionPrompt: 'DO NOT USE THIS COPY — fallback trigger prompt',
				}),
			],
		})
		const steps: LoopStep[] = [
			buildLoopStep({
				triggerId: 't-not-pending',
				triggerActionPrompt: 'Not pending — should not surface',
				agent: { id: 'actor-first-agent', name: 'First agent', description: null },
				waitingOnViewer: false,
				pendingCount: 0,
			}),
			buildLoopStep({
				triggerId: 't-pending',
				triggerActionPrompt: 'Approve the outbound draft?',
				agent: { id: 'actor-pending', name: 'Pending step agent', description: null },
				waitingOnViewer: true,
				pendingCount: 2,
			}),
		]
		mockUseLoopSteps.mockReturnValue({ data: steps })

		render(<LoopDetailRoute />)

		expect(screen.getByRole('region', { name: /Pending ask/i })).toBeInTheDocument()
		// Copy comes from the FIRST pending step — the step's agent name and its
		// triggerActionPrompt, NOT the loop-first-agent or the trigger fallback.
		expect(screen.getByText(/Pending step agent asks/)).toBeInTheDocument()
		expect(screen.getByText(/Approve the outbound draft\?/)).toBeInTheDocument()
		expect(screen.queryByText(/First agent asks/)).not.toBeInTheDocument()
		expect(screen.queryByText(/fallback trigger prompt/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/is waiting on your input/i)).not.toBeInTheDocument()
	})

	it('pendingCount counts steps where isWaitingOnViewer is true', () => {
		setFlags({ umbrella: true, stepFlow: true })
		const loop = buildLoopSummary({
			id: 'loop-1',
			// The loop-level count is deliberately different — the wiring must
			// derive pendingCount from the step feed, not from `waitingCount`.
			waitingOnViewer: true,
			waitingCount: 99,
			triggerIds: ['t-a', 't-b', 't-c'],
		})
		mockUseLoops.mockReturnValue({ data: [loop] })
		mockUseLoopSteps.mockReturnValue({
			data: [
				buildLoopStep({
					triggerId: 't-a',
					triggerActionPrompt: 'Ask A',
					agent: { id: 'a', name: 'Agent A', description: null },
					waitingOnViewer: true,
				}),
				buildLoopStep({
					triggerId: 't-b',
					waitingOnViewer: false,
				}),
				buildLoopStep({
					triggerId: 't-c',
					waitingOnViewer: true,
				}),
			],
		})

		render(<LoopDetailRoute />)

		// Two pending steps → aggregated badge renders `+1` (pendingCount − 1)
		// and the aria-label reads "2 pending". Verifies the wiring, not the
		// loop-level `waitingCount` of 99 that a stale reader would pick up.
		expect(screen.getByLabelText('2 pending')).toBeInTheDocument()
		expect(screen.getByText('+1')).toBeInTheDocument()
	})

	it('hides the banner when no step is pending, even if the loop-level waitingOnViewer bit is true', () => {
		setFlags({ umbrella: true, stepFlow: true })
		const loop = buildLoopSummary({
			id: 'loop-1',
			// Loop-level bit says "waiting" but the per-step feed says no step is
			// actually pending. Under step_flow, the per-step feed wins — the
			// banner must NOT render on a stale loop-level bit.
			waitingOnViewer: true,
			waitingCount: 3,
			triggerIds: ['t-a'],
		})
		mockUseLoops.mockReturnValue({ data: [loop] })
		mockUseLoopSteps.mockReturnValue({
			data: [buildLoopStep({ triggerId: 't-a', waitingOnViewer: false })],
		})

		render(<LoopDetailRoute />)

		expect(screen.queryByRole('region', { name: /Pending ask/i })).not.toBeInTheDocument()
	})

	it('falls back to the loop-level waitingOnViewer bit when step_flow is off but the umbrella is on', () => {
		// Sub-flag off: the banner still renders under the umbrella alone, and
		// pendingCount falls back to the loop-level `waitingCount` because
		// there is no per-step feed to count from.
		setFlags({ umbrella: true, stepFlow: false })
		const loop = buildLoopSummary({
			id: 'loop-1',
			waitingOnViewer: true,
			waitingCount: 4,
			agentIds: ['actor-first-agent'],
			triggerIds: ['t-a'],
		})
		mockUseLoops.mockReturnValue({ data: [loop] })
		mockUseActors.mockReturnValue({
			data: [
				{
					id: 'actor-first-agent',
					name: 'First agent',
					type: 'agent',
					email: null,
					description: null,
					isSystem: false,
					agentState: 'idle',
				},
			],
		})
		// step_flow off → useLoopSteps is called with enabled=false, its data
		// stays undefined. Emulate that here.
		mockUseLoopSteps.mockReturnValue({ data: undefined })

		render(<LoopDetailRoute />)

		expect(screen.getByRole('region', { name: /Pending ask/i })).toBeInTheDocument()
		// No per-step data → the copy fallback is the loop's first agent + the
		// SPEC's "is waiting on your input." tail (the trigger-actionPrompt
		// fallback has been dropped).
		expect(screen.getByText(/First agent asks/)).toBeInTheDocument()
		expect(screen.getByText(/is waiting on your input\./)).toBeInTheDocument()
		expect(screen.getByLabelText('4 pending')).toBeInTheDocument()
	})

	it('does not render the banner when the umbrella flag is off', () => {
		setFlags({ umbrella: false, stepFlow: false })
		const loop = buildLoopSummary({
			id: 'loop-1',
			waitingOnViewer: true,
			waitingCount: 2,
			triggerIds: ['t-a'],
		})
		mockUseLoops.mockReturnValue({ data: [loop] })
		mockUseLoopSteps.mockReturnValue({ data: undefined })

		render(<LoopDetailRoute />)

		expect(screen.queryByRole('region', { name: /Pending ask/i })).not.toBeInTheDocument()
	})
})
