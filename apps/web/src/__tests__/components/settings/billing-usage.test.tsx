import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionUsageResponse } from '@/lib/api'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		api: {
			actors: { list: vi.fn() },
			sessions: { usage: vi.fn() },
		},
	}
})

import {
	BillingUsageDetails,
	BillingUsageSummary,
	type WorkspaceModelUsage,
	useWorkspaceModelUsage,
} from '@/components/settings/billing-usage'
import { api } from '@/lib/api'

function buildUsage(overrides: Partial<WorkspaceModelUsage> = {}): WorkspaceModelUsage {
	return {
		isLoading: false,
		hasUsage: true,
		failedAgentCount: 0,
		isError: false,
		totalCostUsd: 12.5,
		totalSessions: 6,
		rows: [
			{ id: 'a-1', name: 'Research Agent', type: 'agent', costUsd: 10, sessions: 4, tokens: 12000 },
			{ id: 'a-2', name: 'Ops Agent', type: 'agent', costUsd: 2.5, sessions: 2, tokens: 3000 },
		],
		periodStart: new Date('2026-08-01T00:00:00.000Z'),
		resetsAt: new Date('2026-09-01T00:00:00.000Z'),
		...overrides,
	}
}

function buildTotals(overrides: Partial<SessionUsageResponse['totals']> = {}) {
	return {
		buckets: [],
		totals: {
			session_count: 0,
			total_cost_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_tokens: 0,
			...overrides,
		},
	}
}

describe('BillingUsageSummary', () => {
	// Mockup 2803-2813 — the figure, the period, the reset. No meter: nothing in
	// the API says how much usage is included, so there is no denominator.
	it('renders the month total without a usage meter', () => {
		const { container } = render(<BillingUsageSummary usage={buildUsage()} />)

		expect(screen.getByText('$12.50')).toBeInTheDocument()
		expect(screen.getByText('model usage this month')).toBeInTheDocument()
		expect(screen.getByText(/resets/)).toBeInTheDocument()
		expect(container.querySelector('[style*="width"]')).toBeNull()
	})

	it('says nothing was recorded rather than showing $0.00', () => {
		render(
			<BillingUsageSummary
				usage={buildUsage({ hasUsage: false, totalCostUsd: 0, totalSessions: 0, rows: [] })}
			/>,
		)

		expect(screen.getByText('No model usage recorded this month yet.')).toBeInTheDocument()
		expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
	})

	// A failed usage query contributes 0, so the total silently under-reports the
	// bill. The figure may still be shown, but never as if it were complete.
	it('warns that the total is partial when some agents failed to load', () => {
		render(<BillingUsageSummary usage={buildUsage({ failedAgentCount: 2 })} />)

		expect(screen.getByText('$12.50')).toBeInTheDocument()
		expect(screen.getByRole('status')).toHaveTextContent(
			"Couldn't load usage for 2 agents — the figures below are incomplete.",
		)
	})

	it('shows no total at all when every usage query failed', () => {
		render(
			<BillingUsageSummary
				usage={buildUsage({
					isError: true,
					failedAgentCount: 2,
					hasUsage: false,
					totalCostUsd: 0,
					totalSessions: 0,
					rows: [],
				})}
			/>,
		)

		expect(screen.getByText('Model usage is unavailable right now.')).toBeInTheDocument()
		expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
		// The load failure must not be reported as an absence of usage.
		expect(screen.queryByText('No model usage recorded this month yet.')).not.toBeInTheDocument()
	})
})

describe('BillingUsageDetails', () => {
	// Mockup 2841-2858 — per-agent rows and the workspace total behind a disclosure.
	it('lists each agent with its sessions and cost once opened', async () => {
		const user = userEvent.setup()
		render(<BillingUsageDetails usage={buildUsage()} />)

		expect(screen.queryByText('Research Agent')).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /Usage details/ }))

		expect(screen.getByText('Research Agent')).toBeInTheDocument()
		expect(screen.getByText('$10.00')).toBeInTheDocument()
		expect(screen.getByText('Ops Agent')).toBeInTheDocument()
		expect(screen.getByText('$2.50')).toBeInTheDocument()
		// The total is the sum of the rows, not a separate figure.
		expect(screen.getByText('$12.50')).toBeInTheDocument()
	})

	it('explains the empty case instead of rendering an empty table', async () => {
		const user = userEvent.setup()
		render(
			<BillingUsageDetails
				usage={buildUsage({ hasUsage: false, totalCostUsd: 0, totalSessions: 0, rows: [] })}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /Usage details/ }))

		expect(screen.getByText(/No agent has finished a session this month/)).toBeInTheDocument()
	})

	it('distinguishes a load failure from an absence of usage', async () => {
		const user = userEvent.setup()
		render(
			<BillingUsageDetails
				usage={buildUsage({
					isError: true,
					failedAgentCount: 2,
					hasUsage: false,
					totalCostUsd: 0,
					totalSessions: 0,
					rows: [],
				})}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /Usage details/ }))

		expect(
			screen.getByText(/This is a loading failure, not an absence of usage/),
		).toBeInTheDocument()
		expect(screen.queryByText(/No agent has finished a session this month/)).not.toBeInTheDocument()
	})
})

describe('useWorkspaceModelUsage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('sums the per-agent usage endpoint and drops agents that never ran', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			{ id: 'a-1', type: 'agent', name: 'Research Agent' },
			{ id: 'a-2', type: 'agent', name: 'Idle Agent' },
			{ id: 'h-1', type: 'human', name: 'Sebastian' },
			// biome-ignore lint/suspicious/noExplicitAny: trimmed actor rows keep the fixture readable
		] as any)
		vi.mocked(api.sessions.usage).mockImplementation(async (_ws, params) =>
			params.actor_id === 'a-1'
				? (buildTotals({
						session_count: 4,
						total_cost_usd: 10,
						input_tokens: 1000,
					}) as SessionUsageResponse)
				: (buildTotals() as SessionUsageResponse),
		)

		const { result } = renderHook(() => useWorkspaceModelUsage('ws-1'), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isLoading).toBe(false))

		expect(result.current.totalCostUsd).toBe(10)
		expect(result.current.totalSessions).toBe(4)
		expect(result.current.rows).toHaveLength(1)
		expect(result.current.rows[0]?.name).toBe('Research Agent')
		// Humans never carry session cost — they are not queried at all.
		expect(vi.mocked(api.sessions.usage).mock.calls.map((c) => c[1].actor_id)).toEqual([
			'a-1',
			'a-2',
		])
	})
})
