import type { ActorListItem, LoopSummary, TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
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
}))

const mockUseActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/loops/index'

const LoopsPage = (Route as unknown as { component: React.FC }).component

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

beforeEach(() => {
	vi.clearAllMocks()
	mockUseLoops.mockReturnValue({ data: [], isLoading: false })
	mockUseTriggers.mockReturnValue({ data: [] })
	mockUseActors.mockReturnValue({ data: [] })
})

describe('LoopsPage', () => {
	it('renders the empty state when there are no loops', () => {
		render(<LoopsPage />)

		expect(screen.getByRole('heading', { name: 'Loops' })).toBeInTheDocument()
		expect(screen.getByText('No loops running here yet')).toBeInTheDocument()
	})

	it('does not render the "Not tied to a loop" section for workspaces with only triggers', () => {
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })

		render(<LoopsPage />)

		expect(screen.queryByText('Not tied to a loop')).not.toBeInTheDocument()
		expect(screen.getByText('No loops running here yet')).toBeInTheDocument()
	})

	it('renders a row per loop and no not-tied section when all triggers belong to loops', () => {
		const actors = [buildActor({ id: 'actor-1', name: 'Compass' })]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [buildTrigger({ id: 't-tied', targetActorId: 'actor-1' })],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		expect(screen.queryByText('Not tied to a loop')).not.toBeInTheDocument()
	})

	it('renders the not-tied section when there are both loops and standalone triggers', () => {
		const actors = [
			buildActor({ id: 'actor-1', name: 'Compass' }),
			buildActor({ id: 'actor-standalone', name: 'Watcher' }),
		]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [
				buildTrigger({ id: 't-tied', targetActorId: 'actor-1' }),
				buildTrigger({
					id: 't-standalone',
					name: 'Standalone alert',
					targetActorId: 'actor-standalone',
				}),
			],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		expect(screen.getByText('Not tied to a loop')).toBeInTheDocument()
		expect(screen.getByText('Standalone alert')).toBeInTheDocument()
		expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument()
	})

	it('renders the list skeleton while loops are loading', () => {
		mockUseLoops.mockReturnValue({ data: undefined, isLoading: true })

		const { container } = render(<LoopsPage />)
		expect(screen.queryByText('No loops running here yet')).not.toBeInTheDocument()
		expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
	})
})
