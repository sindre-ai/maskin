import { AgentDocumentView } from '@/components/agents/agent-document'
import { render } from '@testing-library/react'
import axe from 'axe-core'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
	useDeleteActor: () => ({ mutate: vi.fn(), isPending: false }),
	useResetActor: () => ({ mutate: vi.fn(), isPending: false }),
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentRun: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentPause: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEvents: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForActor: () => ({ data: [] }),
	useActorSessionsInfinite: () => ({
		data: { pages: [[]] },
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
	useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
	useSession: () => ({ data: null }),
	useSessionErrorLog: () => ({ data: null }),
	useSessionLogs: () => ({ data: [], isLoading: false }),
}))

vi.mock('@/hooks/use-session-usage', () => ({
	useSessionUsage: () => ({ data: undefined, isLoading: false, error: null }),
	pickBucket: () => 'day',
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '2m 30s',
}))

vi.mock('@/components/agents/session-detail-panel', () => ({
	SessionDetailPanel: () => null,
	FailureCard: () => null,
	parseFailureReason: () => null,
}))

vi.mock('@/components/agents/mcp-servers', () => ({
	McpServers: () => null,
}))

vi.mock('@/components/agents/skills', () => ({
	Skills: () => null,
}))

vi.mock('@/components/activity/activity-item', () => ({
	ActivityItem: ({ event }: { event: { action: string } }) => <div>{event.action}</div>,
}))

vi.mock('@/components/shared/relative-time', () => ({
	RelativeTime: () => <span>some time ago</span>,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))

// jsdom can't reliably compute Tailwind contrast, so static-DOM rules are the
// signal here. color-contrast remains a browser-only check.
const STATIC_DOM_RULES = [
	'label',
	'button-name',
	'aria-valid-attr-value',
	'aria-valid-attr',
	'aria-required-attr',
	'aria-allowed-attr',
	'aria-roles',
	'aria-hidden-focus',
	'image-alt',
	'duplicate-id-aria',
] as const

async function runAxe(container: HTMLElement): Promise<axe.AxeResults> {
	return axe.run(container, {
		runOnly: { type: 'rule', values: [...STATIC_DOM_RULES] },
	})
}

const agent = buildActorResponse({ name: 'Scout', description: 'Test agent', type: 'agent' })

describe('AgentDocumentView accessibility', () => {
	it('has no static-DOM axe violations on the idle empty state', async () => {
		const Wrapper = createWorkspaceWrapper()
		const { container } = render(
			<AgentDocumentView
				agent={agent}
				workspaceId="ws-1"
				events={[]}
				activeSessions={[]}
				recentSessions={[]}
				onUpdateName={() => {}}
				onUpdateDescription={() => {}}
				onUpdateSystemPrompt={() => {}}
				onUpdateLlmProvider={() => {}}
				onUpdateLlmConfig={() => {}}
				onUpdateTools={() => {}}
				onUpdateMemory={() => {}}
				onRun={() => {}}
				onPause={() => {}}
			/>,
			{ wrapper: Wrapper },
		)
		const results = await runAxe(container)
		expect(results.violations).toEqual([])
	})

	it('has no static-DOM axe violations with an active session card and a failed session row', async () => {
		const Wrapper = createWorkspaceWrapper()
		const activeSessions = [
			buildSessionResponse({
				id: 'session-active',
				status: 'running',
				actionPrompt: 'Investigate the failing deploy',
			}),
		]
		const recentSessions = [
			buildSessionResponse({
				id: 'session-failed',
				status: 'failed',
				actionPrompt: 'Sweep stale objects',
				result: { error: 'boom', exit_code: 1 },
				completedAt: '2026-01-01T01:00:00Z',
			}),
			buildSessionResponse({
				id: 'session-ok',
				status: 'completed',
				actionPrompt: 'Daily summary',
				completedAt: '2026-01-01T02:00:00Z',
			}),
		]
		const { container } = render(
			<AgentDocumentView
				agent={agent}
				workspaceId="ws-1"
				events={[]}
				activeSessions={activeSessions}
				recentSessions={recentSessions}
				onUpdateName={() => {}}
				onUpdateDescription={() => {}}
				onUpdateSystemPrompt={() => {}}
				onUpdateLlmProvider={() => {}}
				onUpdateLlmConfig={() => {}}
				onUpdateTools={() => {}}
				onUpdateMemory={() => {}}
				onRun={() => {}}
				onPause={() => {}}
			/>,
			{ wrapper: Wrapper },
		)
		const results = await runAxe(container)
		expect(results.violations).toEqual([])
	})
})
