import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			usage: vi.fn(),
		},
	},
}))

vi.mock('recharts', () => {
	const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
	return {
		Bar: Stub,
		BarChart: Stub,
		CartesianGrid: Stub,
		ResponsiveContainer: Stub,
		Tooltip: Stub,
		XAxis: Stub,
		YAxis: Stub,
	}
})

import { AgentUsageChart } from '@/components/agents/agent-usage-chart'
import type { ActorResponse, SessionUsageResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../../setup'

const agent: ActorResponse = {
	id: 'agent-1',
	type: 'agent',
	name: 'Test Agent',
	email: null,
	description: null,
	bio: null,
	notification_prefs: null,
	system_prompt: null,
	tools: null,
	memory: null,
	llm_provider: null,
	llm_config: null,
	isSystem: false,
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
}

const emptyUsage: SessionUsageResponse = {
	buckets: [],
	totals: {
		session_count: 0,
		total_cost_usd: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_tokens: 0,
	},
}

const populatedUsage: SessionUsageResponse = {
	buckets: [
		{
			bucket: '2026-05-01T00:00:00Z',
			session_count: 3,
			total_cost_usd: 0.42,
			input_tokens: 1000,
			output_tokens: 500,
			cache_tokens: 0,
		},
	],
	totals: {
		session_count: 12,
		total_cost_usd: 1.234,
		input_tokens: 50_000,
		output_tokens: 25_000,
		cache_tokens: 10_000,
	},
}

describe('AgentUsageChart', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows the empty state when there is no usage', async () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(emptyUsage)
		render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(await screen.findByText(/No usage in this range/i)).toBeInTheDocument()
	})

	it('renders aggregate totals when data is loaded', async () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(populatedUsage)
		render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(await screen.findByText(/\$1\.234/)).toBeInTheDocument()
		expect(screen.getByText(/85,000/)).toBeInTheDocument()
		expect(screen.getByText('12')).toBeInTheDocument()
	})

	it('renders Tokens and Cost view toggle buttons', () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(emptyUsage)
		render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('tab', { name: /Tokens/i })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /Cost/i })).toBeInTheDocument()
	})

	it('renders preset range buttons', () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(emptyUsage)
		render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument()
	})

	it('lays the stats out single-column below sm and three-column above', async () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(emptyUsage)
		const { container } = render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		await screen.findByText('Total cost')
		const grid = container.querySelector('.grid-cols-1')
		expect(grid).not.toBeNull()
		expect(grid?.className).toMatch(/\bgrid-cols-1\b/)
		expect(grid?.className).toMatch(/\bsm:grid-cols-3\b/)
	})
})
