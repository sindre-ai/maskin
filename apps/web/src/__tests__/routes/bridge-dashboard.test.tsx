import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseActors = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => mockUseActors(...args),
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/sindre/sindre-pulse-bar', () => ({
	SindrePulseBar: ({ sindreActorId }: { sindreActorId: string | null }) => (
		<div data-testid="sindre-pulse-bar" data-sindre-actor-id={sindreActorId ?? ''} />
	),
}))

vi.mock('@/components/dashboard/dashboard-headline', () => ({
	DashboardHeadline: () => <div data-testid="dashboard-headline" />,
}))

vi.mock('@/components/dashboard/now-happening-hero', () => ({
	NowHappeningHero: () => <div data-testid="now-happening-hero" />,
}))

vi.mock('@/components/dashboard/decisions-panel', () => ({
	DecisionsPanel: () => <div data-testid="decisions-panel" />,
}))

vi.mock('@/components/dashboard/team-roster', () => ({
	TeamRoster: () => <div data-testid="team-roster" />,
}))

vi.mock('@/components/dashboard/pipeline-flow', () => ({
	PipelineFlow: () => <div data-testid="pipeline-flow" />,
}))

vi.mock('@/components/dashboard/live-feed-captions', () => ({
	LiveFeedCaptions: () => <div data-testid="live-feed-captions" />,
}))

vi.mock('@/components/dashboard/vitals-strip', () => ({
	VitalsStrip: ({ workspaceId }: { workspaceId: string }) => (
		<div data-testid="vitals-strip" data-workspace-id={workspaceId} />
	),
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const BridgeDashboard = (Route as unknown as { component: React.FC }).component

describe('BridgeDashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('renders all seven dashboard sections plus the Sindre pulse bar', () => {
		render(<BridgeDashboard />)
		expect(screen.getByTestId('dashboard-headline')).toBeInTheDocument()
		expect(screen.getByTestId('sindre-pulse-bar')).toBeInTheDocument()
		expect(screen.getByTestId('now-happening-hero')).toBeInTheDocument()
		expect(screen.getByTestId('decisions-panel')).toBeInTheDocument()
		expect(screen.getByTestId('team-roster')).toBeInTheDocument()
		expect(screen.getByTestId('pipeline-flow')).toBeInTheDocument()
		expect(screen.getByTestId('live-feed-captions')).toBeInTheDocument()
		expect(screen.getByTestId('vitals-strip')).toBeInTheDocument()
	})

	it('passes the workspace id to VitalsStrip', () => {
		render(<BridgeDashboard />)
		expect(screen.getByTestId('vitals-strip')).toHaveAttribute('data-workspace-id', 'ws-1')
	})

	it('resolves the Sindre actor id and forwards it to SindrePulseBar', () => {
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'a-1', type: 'agent', name: 'Eli' },
				{ id: 'a-2', type: 'agent', name: 'Sindre' },
			],
		})
		render(<BridgeDashboard />)
		expect(screen.getByTestId('sindre-pulse-bar')).toHaveAttribute(
			'data-sindre-actor-id',
			'a-2',
		)
	})

	it('passes a null Sindre actor id when no Sindre agent exists', () => {
		mockUseActors.mockReturnValue({
			data: [{ id: 'a-1', type: 'agent', name: 'Eli' }],
		})
		render(<BridgeDashboard />)
		expect(screen.getByTestId('sindre-pulse-bar')).toHaveAttribute('data-sindre-actor-id', '')
	})
})
