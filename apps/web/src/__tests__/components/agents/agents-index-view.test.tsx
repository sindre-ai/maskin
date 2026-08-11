import { AgentsIndexView } from '@/components/agents/agents-index-view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildSessionResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter() }
})

type DisplaySettingsBody = Record<string, unknown>
type MockState = {
	__dsUpsertCalls: number
	__dsLastUpsertBody: DisplaySettingsBody | null
	__dsPersistedSettings: DisplaySettingsBody
}
const mockState = globalThis as unknown as MockState
mockState.__dsUpsertCalls = 0
mockState.__dsLastUpsertBody = null
mockState.__dsPersistedSettings = {}

vi.mock('@/lib/api', () => {
	class ApiError extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message)
		}
	}
	const state = globalThis as unknown as MockState
	return {
		ApiError,
		api: {
			userDisplaySettings: {
				list: async () => ({ items: [] }),
				get: async () => ({
					object_type: 'agents',
					name: 'default',
					settings: state.__dsPersistedSettings,
					updated_at: '2026-05-28T10:00:00.000Z',
				}),
				upsert: async (_wsId: string, _objectType: string, settings: DisplaySettingsBody) => {
					state.__dsUpsertCalls++
					state.__dsLastUpsertBody = settings
					return {
						object_type: 'agents',
						name: 'default',
						settings,
						updated_at: '2026-05-28T10:00:00.000Z',
					}
				},
			},
		},
	}
})

const agentAda = () =>
	buildActorListItem({
		id: 'agent-ada',
		name: 'Ada',
		type: 'agent',
		description: 'Researcher\nOwns depth',
	})
const agentBrian = () =>
	buildActorListItem({
		id: 'agent-brian',
		name: 'Brian',
		type: 'agent',
		description: 'Architect',
	})
const agentCy = () =>
	buildActorListItem({
		id: 'agent-cy',
		name: 'Cy',
		type: 'agent',
		description: 'Reviewer',
		agentState: 'failed',
	})
const brianRunningSession = () =>
	buildSessionResponse({
		id: 's-1',
		actorId: 'agent-brian',
		status: 'running',
		actionPrompt: 'Crunching numbers',
	})

function mount(
	agents: ReturnType<typeof buildActorListItem>[],
	sessions: ReturnType<typeof buildSessionResponse>[],
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={queryClient}>
			<AgentsIndexView workspaceId="ws-1" agents={agents} sessions={sessions} />
		</QueryClientProvider>,
	)
}

async function flushHydrateAndWriteThrough() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 100))
	})
	await act(async () => {
		await new Promise((r) => setTimeout(r, 1000))
	})
}

function resetMockState() {
	mockState.__dsUpsertCalls = 0
	mockState.__dsLastUpsertBody = null
	mockState.__dsPersistedSettings = {}
}

beforeEach(resetMockState)

describe('AgentsIndexView', () => {
	describe('grouped sections', () => {
		it('renders Working / Idle / Failed sections with label, count, and note', () => {
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])
			const working = screen.getByRole('heading', { name: /working/i })
			expect(working.closest('div')).toHaveTextContent('1')
			expect(screen.getByText('Agents with a session in progress')).toBeInTheDocument()
			const idle = screen.getByRole('heading', { name: /idle/i })
			expect(idle.closest('div')).toHaveTextContent('1')
			expect(screen.getByText('Standing by for their next run')).toBeInTheDocument()
			const failed = screen.getByRole('heading', { name: /failed/i })
			expect(failed.closest('div')).toHaveTextContent('1')
			expect(screen.getByText('Last run errored')).toBeInTheDocument()
		})

		it('shows a per-group empty state for sections with no agents', () => {
			mount(
				[agentAda()],
				[buildSessionResponse({ id: 's-ada', actorId: 'agent-ada', status: 'running' })],
			)
			expect(screen.queryByText('No working agents')).not.toBeInTheDocument()
			expect(screen.getByText('No idle agents')).toBeInTheDocument()
			expect(screen.getByText('No failed agents')).toBeInTheDocument()
		})
	})

	describe('rows', () => {
		it('renders name, kind, activity, session count, and status pill per row', () => {
			const bob = buildActorListItem({
				id: 'agent-bob',
				name: 'Bob',
				type: 'agent',
				description: 'Architect',
			})
			const sessions = [
				buildSessionResponse({
					id: 's1',
					actorId: 'agent-bob',
					status: 'completed',
					actionPrompt: undefined,
				}),
				buildSessionResponse({
					id: 's2',
					actorId: 'agent-bob',
					status: 'completed',
					actionPrompt: undefined,
				}),
			]
			mount([bob], sessions)
			const row = screen.getAllByRole('listitem')[0]
			expect(within(row).getByRole('link', { name: 'Bob' })).toBeInTheDocument()
			expect(within(row).getByText('Architect · Standing by · 2 sessions')).toBeInTheDocument()
			expect(within(row).getByText('Idle')).toBeInTheDocument()
		})
	})

	describe('Display menu', () => {
		it('filters rows by status through the Display menu and resets the filter', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			expect(screen.getByRole('link', { name: 'Brian' })).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Display' }))
			await user.click(screen.getByRole('button', { name: /\+ status/i }))
			await user.click(screen.getByRole('menuitemcheckbox', { name: 'working' }))

			expect(screen.getByRole('link', { name: 'Brian' })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: 'Ada' })).not.toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /idle/i })).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /reset/i }))
			expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument()
		})
	})

	describe('display-settings persistence', () => {
		it('persists hydrated settings through the debounce without looping writes', async () => {
			mockState.__dsPersistedSettings = {
				sort: 'name',
				order: 'desc',
				groupBy: 'kind',
				columnVisibility: { activity: false },
			}
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			await flushHydrateAndWriteThrough()
			expect(mockState.__dsUpsertCalls).toBeGreaterThan(0)
			const afterHydrate = mockState.__dsUpsertCalls
			await act(async () => {
				await new Promise((r) => setTimeout(r, 2500))
			})
			expect(mockState.__dsUpsertCalls).toBe(afterHydrate)
		}, 10_000)

		it('writes the hydrated settings as the persisted blob', async () => {
			mockState.__dsPersistedSettings = {
				sort: 'name',
				order: 'desc',
				groupBy: 'kind',
				columnVisibility: { activity: false },
			}
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			await flushHydrateAndWriteThrough()
			expect(mockState.__dsLastUpsertBody).toEqual({
				sort: 'name',
				order: 'desc',
				groupBy: 'kind',
				columnVisibility: { activity: false },
			})
		}, 10_000)

		it('hydrates a persisted status filter and column visibility on mount', async () => {
			mockState.__dsPersistedSettings = {
				sort: 'name',
				order: 'asc',
				groupBy: 'status',
				columnVisibility: { kind: false },
				filters: { status: 'working' },
			}
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])
			await flushHydrateAndWriteThrough()
			expect(screen.getByRole('heading', { name: /working/i })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /idle/i })).not.toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /failed/i })).not.toBeInTheDocument()
			// kind:false hides the kind segment; activity + session count remain.
			const row = screen.getByRole('listitem')
			expect(within(row).getByText('Crunching numbers · 1 session')).toBeInTheDocument()
		}, 10_000)
	})
})
