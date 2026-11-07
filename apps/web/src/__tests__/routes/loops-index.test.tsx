import type { ActorListItem, LoopSummary, SessionResponse, TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

const mockUseLoops = vi.fn()
vi.mock('@/hooks/use-loops', () => ({
	useLoops: () => mockUseLoops(),
}))

const mockUseTriggers = vi.fn()
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => mockUseTriggers(),
	useUpdateTrigger: () => ({ mutate: mockUpdateTrigger, isPending: false }),
}))

const mockUseActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

const mockUseWorkspaceSessions = vi.fn()
vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => mockUseWorkspaceSessions(),
	useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
}))

const mockUpdateTrigger = vi.fn()
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null, isFetched: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn(), isPending: false }),
}))

// The panel is stubbed to its filter rows, so the tests can press them.
vi.mock('@/components/objects/data-table/display-panel', () => ({
	DisplayPanel: ({
		filterSections,
	}: {
		filterSections?: {
			id: string
			label: string
			options: { id: string; label: string; onToggle: () => void }[]
		}[]
	}) => (
		<div>
			<button type="button">Display</button>
			{filterSections?.flatMap((section) =>
				section.options.map((option) => (
					<button key={`${section.id}-${option.id}`} type="button" onClick={option.onToggle}>
						{`${section.label}: ${option.label}`}
					</button>
				)),
			)}
		</div>
	),
}))

vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({
		title,
		subtitle,
		actions,
	}: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
		<div>
			<h1>
				{title}
				{subtitle ? ` ${subtitle}` : ''}
			</h1>
			{actions}
		</div>
	),
}))

// The route reads workspace billing at its boundary to derive the NO CREDITS
// pill overlay (D1). Stub both here so this route-level suite doesn't need a
// QueryClientProvider or the billing API surface — the pill's own render logic
// is asserted in `components/loops/loop-row.test.tsx`.
const mockUseBillingUsage = vi.fn()
vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: () => mockUseBillingUsage(),
}))

vi.mock('@/components/settings/buy-credits-dialog', () => ({
	BuyCreditsDialog: () => null,
}))

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/loops/index'

const LoopsPage = (Route as unknown as { component: React.FC }).component

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId: 'ws-1',
		name: 'Customer feedback',
		content: 'Every customer who gives feedback hears back within 30 days',
		status: 'supervised',
		pill: 'supervised',
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

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't-1',
		workspaceId: 'ws-1',
		name: 'Nightly sweep',
		type: 'cron',
		targetActorId: 'actor-1',
		config: { expression: '0 3 * * *' },
		enabled: true,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		...overrides,
	} as TriggerResponse
}

function buildSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
	return {
		id: 's-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		triggerId: null,
		status: 'running',
		actionPrompt: 'Look into the recent churn spike',
		startedAt: '2026-08-04T00:00:00.000Z',
		createdAt: '2026-08-04T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		currentActivity: 'Drafting a summary',
		...overrides,
	} as SessionResponse
}

beforeEach(() => {
	vi.clearAllMocks()
	mockUseLoops.mockReturnValue({ data: [], isLoading: false })
	mockUseTriggers.mockReturnValue({ data: [] })
	mockUseActors.mockReturnValue({ data: [] })
	mockUseWorkspaceSessions.mockReturnValue({ data: [] })
	mockUseBillingUsage.mockReturnValue({ data: undefined })
})

/** The automations section is collapsed by default; open it the way a person does. */
async function openAutomations() {
	await userEvent.setup().click(screen.getByRole('button', { name: 'Not tied to a flow' }))
}

describe('LoopsPage', () => {
	it('renders the empty state when there are no loops', () => {
		render(<LoopsPage />)

		expect(screen.getByText('No flows running here yet')).toBeInTheDocument()
	})

	it('lists standalone triggers for a workspace that has triggers but no loops', async () => {
		// The fold-in's core regression: with /triggers gone, the only way into a
		// trigger is this list, so it must not be gated on a loop existing.
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })
		mockUseActors.mockReturnValue({ data: [buildActor()] })

		render(<LoopsPage />)
		await openAutomations()

		expect(screen.getByText('Not tied to a flow')).toBeInTheDocument()
		expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
		// The loops empty state renders inline as a section, not as the whole page.
		expect(screen.getByText('No flows running here yet')).toBeInTheDocument()
	})

	it('says in plain text how many flows need you, with a clause per flow that says why', () => {
		mockUseLoops.mockReturnValue({
			data: [
				buildLoop({
					id: 'l-wait',
					name: 'Needs a decision',
					pill: 'waiting_on_you',
					waitingCount: 2,
				}),
				buildLoop({ id: 'l-calm', name: 'Calm flow' }),
			],
			isLoading: false,
		})
		render(<LoopsPage />)

		const brief = screen.getByTestId('flows-brief')
		expect(brief).toHaveTextContent('1 of 2 flows need you.')
		expect(brief).toHaveTextContent('Needs a decision: 2 items wait for you.')
		expect(brief).not.toHaveTextContent('Calm flow')
	})

	it('groups loops under their first tag, A to Z, untagged last', () => {
		mockUseLoops.mockReturnValue({
			data: [
				buildLoop({ id: 'l1', name: 'Seo flow', tags: ['Marketing'] }),
				buildLoop({ id: 'l2', name: 'Delivery flow', tags: ['Product'] }),
				buildLoop({ id: 'l3', name: 'Loose flow', tags: [] }),
			],
			isLoading: false,
		})
		render(<LoopsPage />)

		const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
		expect(headings.slice(0, 3)).toEqual(['Marketing', 'Product', 'No team'])
	})

	describe('search and Display filters', () => {
		const loops = () => [
			buildLoop({ id: 'l1', name: 'Seo flow', tags: ['Marketing'], content: 'Ranks pages' }),
			buildLoop({ id: 'l2', name: 'Delivery flow', tags: ['Product'] }),
			buildLoop({ id: 'l3', name: 'Loose flow', tags: [] }),
		]

		it('narrows the list by every typed word, in name, description or tag', async () => {
			const user = userEvent.setup()
			mockUseLoops.mockReturnValue({ data: loops(), isLoading: false })
			render(<LoopsPage />)

			await user.type(
				screen.getAllByRole('searchbox', { name: 'Search flows' })[0],
				'ranks marketing',
			)
			expect(screen.getByText('Seo flow')).toBeInTheDocument()
			expect(screen.queryByText('Delivery flow')).not.toBeInTheDocument()
			expect(screen.queryByText('Loose flow')).not.toBeInTheDocument()
		})

		it('says so when nothing matches', async () => {
			const user = userEvent.setup()
			mockUseLoops.mockReturnValue({ data: loops(), isLoading: false })
			render(<LoopsPage />)

			await user.type(screen.getAllByRole('searchbox', { name: 'Search flows' })[0], 'zzzz')
			expect(screen.getByText('No flows match.')).toBeInTheDocument()
		})

		it('offers an Area row with one option per first tag, A to Z, untagged last', () => {
			mockUseLoops.mockReturnValue({ data: loops(), isLoading: false })
			render(<LoopsPage />)

			const areas = screen.getAllByRole('button', { name: /^Area: / }).map((b) => b.textContent)
			expect(areas).toEqual(['Area: Marketing', 'Area: Product', 'Area: No team'])
		})

		it('narrows to one area and back again', async () => {
			const user = userEvent.setup()
			mockUseLoops.mockReturnValue({ data: loops(), isLoading: false })
			render(<LoopsPage />)

			await user.click(screen.getByRole('button', { name: 'Area: Product' }))
			expect(screen.getByText('Delivery flow')).toBeInTheDocument()
			expect(screen.queryByText('Seo flow')).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Area: Product' }))
			expect(screen.getByText('Seo flow')).toBeInTheDocument()
		})

		it('has no Area row while no flow carries a tag', () => {
			mockUseLoops.mockReturnValue({
				data: [buildLoop({ id: 'l3', name: 'Loose flow', tags: [] })],
				isLoading: false,
			})
			render(<LoopsPage />)
			expect(screen.queryByRole('button', { name: /^Area: / })).not.toBeInTheDocument()
		})

		it('has a Show row that narrows to flows waiting on you', async () => {
			const user = userEvent.setup()
			mockUseLoops.mockReturnValue({
				data: [
					buildLoop({ id: 'l-wait', name: 'Needs a decision', pill: 'waiting_on_you' }),
					buildLoop({ id: 'l-calm', name: 'Calm flow' }),
				],
				isLoading: false,
			})
			render(<LoopsPage />)

			await user.click(screen.getByRole('button', { name: 'Show: Needs you' }))
			expect(screen.getByText('Needs a decision')).toBeInTheDocument()
			expect(screen.queryByText('Calm flow')).not.toBeInTheDocument()
		})
	})

	it('treats a trigger the loop names in triggerIds as tied, not standalone', async () => {
		const actors = [buildActor({ id: 'actor-1', name: 'Compass' })]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'], triggerIds: ['t-tied'] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [buildTrigger({ id: 't-tied', targetActorId: 'actor-1' })],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)
		await openAutomations()

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		// The section always renders — /triggers redirects here, so it is the only
		// way in; with nothing standalone it shows its own empty state.
		expect(screen.getByText('Not tied to a flow')).toBeInTheDocument()
		expect(screen.getByText('No workspace-wide automations yet')).toBeInTheDocument()
	})

	it('keeps a trigger standalone even when it shares an agent with a loop', async () => {
		// The old heuristic keyed off targetActorId and wrongly hid this row.
		const actors = [buildActor({ id: 'actor-1', name: 'Compass' })]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'], triggerIds: [] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [
				buildTrigger({ id: 't-shared', name: 'Shared agent sweep', targetActorId: 'actor-1' }),
			],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)
		await openAutomations()

		expect(screen.getByText('Not tied to a flow')).toBeInTheDocument()
		expect(screen.getByText('Shared agent sweep')).toBeInTheDocument()
	})

	it('keeps the automations collapsed until the heading is opened, and folds them away again', async () => {
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })
		mockUseActors.mockReturnValue({ data: [buildActor()] })

		render(<LoopsPage />)

		const heading = screen.getByRole('button', { name: 'Not tied to a flow' })
		expect(heading).toHaveAttribute('aria-expanded', 'false')
		expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument()

		await openAutomations()
		expect(heading).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getByText('Nightly sweep')).toBeInTheDocument()

		await openAutomations()
		expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument()
	})

	it('has no "Assigned in chat" section', () => {
		render(<LoopsPage />)

		expect(screen.queryByText('Assigned in chat')).not.toBeInTheDocument()
	})

	it('flips a standalone trigger through its inline switch without navigating', async () => {
		const user = userEvent.setup()
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })
		mockUseActors.mockReturnValue({ data: [buildActor()] })

		render(<LoopsPage />)
		await openAutomations()

		await user.click(screen.getByRole('switch', { name: /disable nightly sweep/i }))

		expect(mockUpdateTrigger).toHaveBeenCalledWith({ id: 't-1', data: { enabled: false } })
	})

	it('renders the list skeleton while loops are loading', () => {
		mockUseLoops.mockReturnValue({ data: undefined, isLoading: true })

		const { container } = render(<LoopsPage />)
		expect(screen.queryByText('No flows running here yet')).not.toBeInTheDocument()
		expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
	})

	it('shows the error card, not the empty state, when the loops fetch fails', () => {
		mockUseLoops.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('boom'),
			refetch: vi.fn(),
		})

		render(<LoopsPage />)

		expect(screen.getByText("Couldn't load flows")).toBeInTheDocument()
		expect(screen.queryByText('No flows running here yet')).not.toBeInTheDocument()
	})
})
