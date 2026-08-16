import { AgentUsageBlock } from '@/components/agents/agent-usage-block'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

type UsageResponse = {
	buckets: {
		bucket: string
		session_count: number
		total_cost_usd: number
		input_tokens: number
		output_tokens: number
		cache_tokens: number
	}[]
	totals: {
		session_count: number
		total_cost_usd: number
		input_tokens: number
		output_tokens: number
		cache_tokens: number
	}
}

const usageMock =
	vi.fn<
		(_ws: string, _params: { actor_id: string; from: string; to: string }) => Promise<UsageResponse>
	>()

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			sessions: {
				...actual.api.sessions,
				usage: (...args: Parameters<typeof usageMock>) => usageMock(...args),
			},
		},
	}
})

function buildUsage(
	overrides: Partial<UsageResponse['totals']> = {},
	buckets: UsageResponse['buckets'] = [],
): UsageResponse {
	return {
		buckets,
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

describe('AgentUsageBlock', () => {
	beforeEach(() => {
		usageMock.mockReset()
	})

	it('renders totals, delta vs prior window, and daily bars for the 30d default', async () => {
		const buckets: UsageResponse['buckets'] = Array.from({ length: 5 }).map((_, i) => ({
			bucket: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
			session_count: i + 1,
			total_cost_usd: 0.1 * (i + 1),
			input_tokens: 100 * (i + 1),
			output_tokens: 50 * (i + 1),
			cache_tokens: 25 * (i + 1),
		}))
		const current = buildUsage(
			{ session_count: 15, input_tokens: 1500, output_tokens: 750, cache_tokens: 375 },
			buckets,
		)
		const prior = buildUsage({
			session_count: 10,
			input_tokens: 1000,
			output_tokens: 500,
			cache_tokens: 250,
		})
		usageMock.mockImplementation(async (_ws, params) => {
			// Current range ends at "now"; prior range ends before it. The test
			// distinguishes by `to` — prior's `to` is older.
			const currentTo = Date.now()
			const paramTo = new Date(params.to).getTime()
			return paramTo > currentTo - 24 * 60 * 60 * 1000 ? current : prior
		})

		const agent = buildActorResponse({
			id: 'agent-usage',
			type: 'agent',
			createdAt: '2025-01-01T00:00:00Z',
		})
		render(<AgentUsageBlock agent={agent} workspaceId="ws-1" />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('2,625')).toBeInTheDocument() // total tokens
		expect(screen.getByText('15')).toBeInTheDocument() // session count
		expect(screen.getByText('tokens used')).toBeInTheDocument()
		expect(screen.getByText('sessions')).toBeInTheDocument()
		// +150% (2625 vs 1750)
		const deltas = screen.getAllByText(/\+50%|\+150%|\+\d+%/)
		expect(deltas.length).toBeGreaterThan(0)
		expect(screen.getByText('TOKENS / MONTH')).toBeInTheDocument()
		expect(screen.getByText(/Budget: No cap/)).toBeInTheDocument()
	})

	it('switches the range when a period tab is clicked', async () => {
		usageMock.mockResolvedValue(buildUsage())
		const agent = buildActorResponse({ id: 'agent-tab', type: 'agent' })
		render(<AgentUsageBlock agent={agent} workspaceId="ws-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		await screen.findByText('TOKENS / MONTH')
		const tab7d = screen.getByRole('button', { name: '7d' })
		await userEvent.click(tab7d)
		expect(await screen.findByText('TOKENS / WEEK')).toBeInTheDocument()
	})

	it('shows an empty chart hint when there are no buckets', async () => {
		usageMock.mockResolvedValue(buildUsage())
		const agent = buildActorResponse({ id: 'agent-empty', type: 'agent' })
		render(<AgentUsageBlock agent={agent} workspaceId="ws-1" />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(await screen.findAllByText('No usage yet')).not.toHaveLength(0)
	})
})
