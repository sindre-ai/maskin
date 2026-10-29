import type { LoopSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../factories'

const mockNavigate = vi.fn()
// Tanstack router — the route file calls `createFileRoute` at module top; the
// mock keeps the returned options shape so the component under test can be
// pulled off `Route.component`, matching `loops-index.test.tsx`.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => ({ loopId: 'loop-1' }),
		}),
	}
})

const mockUseLoops = vi.fn()
const mockUseLoopActivity = vi.fn()
vi.mock('@/hooks/use-loops', () => ({
	useLoop: (id: string) => {
		const loops = mockUseLoops() as { data?: LoopSummary[] }
		return { data: loops.data?.find((l) => l.id === id), isLoading: false, isError: false }
	},
	useLoops: () => mockUseLoops(),
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

const mockDeleteObject = vi.fn()
vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({ data: undefined }),
	useObjects: () => ({ data: [] }),
	useUpdateObject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	useDeleteObject: () => ({ mutate: mockDeleteObject, isPending: false }),
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
	// Render the actions slot so the delete-affordance tests below can query it;
	// the AskBanner tests don't assert against page-header content, so exposing
	// actions here is safe for the whole file.
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <>{actions}</>,
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

beforeEach(() => {
	vi.clearAllMocks()
	mockUseLoopActivity.mockReturnValue({ data: [] })
	mockUseTriggers.mockReturnValue({ data: [] })
	mockUseActors.mockReturnValue({ data: [] })
	mockUseRelationships.mockReturnValue({ data: [] })
})

describe('LoopDetailRoute — AskBanner wiring', () => {
	it('uses the loop-level waitingOnViewer bit and waitingCount for the banner', () => {
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
		render(<LoopDetailRoute />)

		expect(screen.getByRole('region', { name: /Pending ask/i })).toBeInTheDocument()
		// The copy is the loop's first agent + the SPEC's "is waiting on your input." tail (the trigger-actionPrompt
		// fallback has been dropped).
		expect(screen.getByText(/First agent asks/)).toBeInTheDocument()
		expect(screen.getByText(/is waiting on your input\./)).toBeInTheDocument()
		expect(screen.getByLabelText('4 pending')).toBeInTheDocument()
	})
})

describe('LoopDetailRoute — delete affordance', () => {
	beforeEach(() => {
		mockUseLoops.mockReturnValue({
			data: [buildLoopSummary({ id: 'loop-1', name: 'Deal pipeline' })],
		})
	})

	async function openMenu(user: ReturnType<typeof userEvent.setup>) {
		await user.click(screen.getByRole('button', { name: 'More' }))
	}

	it('opens an inline confirm when Delete loop is selected', async () => {
		const user = userEvent.setup()
		render(<LoopDetailRoute />)

		await openMenu(user)
		await user.click(screen.getByRole('menuitem', { name: /Delete loop/i }))

		expect(screen.getByText(/Delete this loop\?/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
		expect(mockDeleteObject).not.toHaveBeenCalled()
	})

	it('fires useDeleteObject with the loop id and navigates back to /loops on success', async () => {
		mockDeleteObject.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) =>
			opts?.onSuccess?.(),
		)
		const user = userEvent.setup()
		render(<LoopDetailRoute />)

		await openMenu(user)
		await user.click(screen.getByRole('menuitem', { name: /Delete loop/i }))
		await user.click(screen.getByRole('button', { name: 'Confirm' }))

		expect(mockDeleteObject).toHaveBeenCalledWith('loop-1', expect.any(Object))
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/loops',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('cancel dismisses the confirm without firing the delete', async () => {
		const user = userEvent.setup()
		render(<LoopDetailRoute />)

		await openMenu(user)
		await user.click(screen.getByRole('menuitem', { name: /Delete loop/i }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(screen.queryByText(/Delete this loop\?/i)).not.toBeInTheDocument()
		expect(mockDeleteObject).not.toHaveBeenCalled()
		expect(mockNavigate).not.toHaveBeenCalled()
	})
})
