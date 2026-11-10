import type { LoopSummary } from '@/lib/api'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('@tanstack/react-query', async (importOriginal) => ({
	...(await importOriginal<typeof import('@tanstack/react-query')>()),
	useQueryClient: () => ({
		cancelQueries: vi.fn(),
		getQueryData: vi.fn(),
		setQueryData: vi.fn(),
	}),
}))
vi.mock('@/hooks/use-briefings', () => ({
	useLoopBriefingPages: () => [],
}))
vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: () => ({ data: [] }),
}))
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => mockUseTriggers(),
	useCreateTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateTrigger: () => ({ mutate: vi.fn(), isPending: false }),
}))

const mockUseRelationships = vi.fn()
vi.mock('@/hooks/use-relationships', () => ({
	useRelationships: () => mockUseRelationships(),
}))

const mockDeleteObject = vi.fn()
const mockUseObject = vi.fn()
vi.mock('@/hooks/use-objects', () => ({
	useObject: () => mockUseObject(),
	useObjects: () => ({ data: [] }),
	useUpdateObject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	useDeleteObject: () => ({ mutate: mockDeleteObject, isPending: false }),
}))

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))

const trackAskBannerDecideClicked = vi.fn()
const trackLoopViewed = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackAskBannerDecideClicked: (payload: unknown) => trackAskBannerDecideClicked(payload),
	trackLoopViewed: (payload: unknown) => trackLoopViewed(payload),
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
vi.mock('@/components/loops/loop-detail-tabs', () => ({
	// The real strip folds tabs under "More" by measured width, which jsdom cannot measure.
	LoopDetailTabs: ({
		tabs,
		onChange,
	}: {
		tabs: { value: string; label: string }[]
		onChange: (value: string) => void
	}) => (
		<div>
			{tabs.map((t) => (
				<button key={t.value} type="button" onClick={() => onChange(t.value)}>
					{t.label}
				</button>
			))}
		</div>
	),
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
	mockUseObject.mockReturnValue({ data: undefined })
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

describe('LoopDetailRoute — loop_viewed', () => {
	it('sends loop_viewed once with the loop id when the page opens', () => {
		mockUseLoops.mockReturnValue({ data: [buildLoopSummary({ id: 'loop-1' })] })
		const { rerender } = render(<LoopDetailRoute />)
		rerender(<LoopDetailRoute />)

		expect(trackLoopViewed).toHaveBeenCalledOnce()
		expect(trackLoopViewed).toHaveBeenCalledWith({ entity_id: 'loop-1' })
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

	it('opens an inline confirm when Delete flow is selected', async () => {
		const user = userEvent.setup()
		render(<LoopDetailRoute />)

		await openMenu(user)
		await user.click(screen.getByRole('menuitem', { name: /Delete flow/i }))

		expect(screen.getByText(/Delete this flow\?/i)).toBeInTheDocument()
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
		await user.click(screen.getByRole('menuitem', { name: /Delete flow/i }))
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
		await user.click(screen.getByRole('menuitem', { name: /Delete flow/i }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(screen.queryByText(/Delete this flow\?/i)).not.toBeInTheDocument()
		expect(mockDeleteObject).not.toHaveBeenCalled()
		expect(mockNavigate).not.toHaveBeenCalled()
	})
})

describe('LoopDetailRoute — slow or failing calls', () => {
	const refetch = vi.fn()

	beforeEach(() => {
		mockUseLoops.mockReturnValue({
			data: [buildLoopSummary({ id: 'loop-1', name: 'Deal pipeline' })],
		})
		mockUseObject.mockReturnValue({ data: { id: 'loop-1', metadata: {} } })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('shows nothing extra when every call answers', () => {
		render(<LoopDetailRoute />)

		expect(screen.queryByTestId('loop-block-error')).not.toBeInTheDocument()
	})

	it('shows a message with Try again for the steps when their calls fail, and the rest stays', async () => {
		const user = userEvent.setup()
		mockUseTriggers.mockReturnValue({ data: undefined, isError: true, refetch })
		render(<LoopDetailRoute />)

		// How the flow runs is on Setup, not Overview.
		await user.click(screen.getByRole('button', { name: 'Setup' }))
		expect(screen.getAllByTestId('loop-block-error')).toHaveLength(1)
		expect(screen.getByText(/Couldn't load how this flow runs/)).toBeInTheDocument()
		expect(screen.queryByText(/recent activity/)).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Try again' }))
		expect(refetch).toHaveBeenCalledTimes(1)
	})

	it('shows a message for the activity when its call fails', async () => {
		const user = userEvent.setup()
		mockUseLoopActivity.mockReturnValue({ data: undefined, isError: true, refetch })
		render(<LoopDetailRoute />)

		await user.click(screen.getByRole('button', { name: 'Activity' }))
		expect(screen.getByText(/Couldn't load the flow's recent activity/)).toBeInTheDocument()
		expect(screen.queryByText(/Couldn't load how this flow runs/)).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Try again' }))
		expect(refetch).toHaveBeenCalledTimes(1)
	})

	it('shows a message for the description when the loop object fails', () => {
		mockUseObject.mockReturnValue({ data: undefined, isError: true, refetch })
		render(<LoopDetailRoute />)

		expect(screen.getByText(/Couldn't load the description/)).toBeInTheDocument()
	})

	it('gives up on a call that is still waiting after 30 seconds', () => {
		vi.useFakeTimers()
		mockUseActors.mockReturnValue({ data: undefined, isLoading: true, refetch })
		render(<LoopDetailRoute />)
		act(() => {
			screen.getByRole('button', { name: 'Setup' }).click()
		})

		act(() => {
			vi.advanceTimersByTime(29_000)
		})
		expect(screen.queryByTestId('loop-block-error')).not.toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(1_000)
		})
		expect(screen.getByText(/Couldn't load how this flow runs/)).toBeInTheDocument()
		expect(screen.getByText(/The server may be busy/)).toBeInTheDocument()
	})
})
