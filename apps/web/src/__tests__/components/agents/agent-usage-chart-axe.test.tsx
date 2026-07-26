import { AgentUsageChart } from '@/components/agents/agent-usage-chart'
import type { ActorResponse, SessionUsageResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { TestWrapper } from '../../setup'

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

const agent: ActorResponse = {
	id: 'agent-1',
	type: 'agent',
	name: 'Test Agent',
	email: null,
	description: null,
	system_prompt: null,
	tools: null,
	memory: null,
	llm_provider: null,
	llm_config: null,
	avatar_url: null,
	isSystem: false,
	agentState: 'idle',
	agentStateUpdatedAt: null,
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

describe('AgentUsageChart accessibility', () => {
	it('has no aria-controls / button-name violations on the view toggle', async () => {
		vi.mocked(api.sessions.usage).mockResolvedValue(emptyUsage)
		const { container } = render(<AgentUsageChart agent={agent} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		// Wait for the totals to populate so the chart is fully rendered.
		await screen.findByText('Total cost')
		const results = await axe.run(container, {
			runOnly: {
				type: 'rule',
				values: [
					'label',
					'button-name',
					'aria-valid-attr-value',
					'aria-valid-attr',
					'aria-required-attr',
					'aria-allowed-attr',
					'aria-roles',
				],
			},
		})
		expect(results.violations).toEqual([])
	})
})
