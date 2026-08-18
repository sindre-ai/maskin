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

/** Picks `option` from the picker row labelled `label`, opening the panel first if needed. */
async function pickFromDisplayPanel(
	user: ReturnType<typeof userEvent.setup>,
	label: string,
	option: string,
) {
	// The panel stays open between picks — only open it if it isn't up already.
	if (!screen.queryByText(label)) {
		await user.click(screen.getByRole('button', { name: 'Display' }))
	}
	const row = screen.getByText(label)
	// The picker row's first button is the dropdown trigger — the ordering row
	// also carries an adjacent asc/desc toggle, so don't assume a single one.
	await user.click(within(row.parentElement as HTMLElement).getAllByRole('button')[0])
	await user.click(screen.getByRole('menuitem', { name: option }))
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
			expect(screen.queryByText('No working agents right now.')).not.toBeInTheDocument()
			expect(screen.getByText('No idle agents right now.')).toBeInTheDocument()
			expect(screen.getByText('No failed agents right now.')).toBeInTheDocument()
		})
	})

	describe('status chips', () => {
		it('renders a chip per bucket with counts computed before filtering', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			const strip = screen.getByRole('group', { name: 'Filter agents by status' })
			expect(within(strip).getByRole('button', { name: 'All (3)' })).toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'Working (1)' })).toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'Idle (1)' })).toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'Failed (1)' })).toBeInTheDocument()

			// Selecting a chip filters the list but leaves every count untouched.
			await user.click(within(strip).getByRole('button', { name: 'Working (1)' }))
			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'All (3)' })).toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'Idle (1)' })).toHaveAttribute(
				'aria-pressed',
				'false',
			)
			expect(within(strip).getByRole('button', { name: 'Working (1)' })).toHaveAttribute(
				'aria-pressed',
				'true',
			)

			// Back to All.
			await user.click(within(strip).getByRole('button', { name: 'All (3)' }))
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
		})

		it('has no per-screen search input — workspace search lives in the nav row', () => {
			mount([agentAda(), agentBrian()], [])
			expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
		})
	})

	describe('rows', () => {
		it('renders the whole row as one link with a kind badge, outcome, activity, count and pill', () => {
			const bob = buildActorListItem({
				id: 'agent-bob',
				name: 'Bob',
				type: 'agent',
				description: 'Architect',
				role: 'member',
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
			// One link covering the whole row, not just the name (mockup 2327).
			const link = screen.getByRole('link')
			const row = link.closest('li') as HTMLElement
			expect(link).toHaveTextContent('Bob')
			expect(within(row).getByText('member')).toBeInTheDocument()
			expect(within(row).getByText('Architect')).toBeInTheDocument()
			expect(within(row).getByText('Standing by')).toBeInTheDocument()
			expect(within(row).getByText('2 sessions')).toBeInTheDocument()
			expect(within(row).getByText('Idle')).toBeInTheDocument()
		})

		it('falls back to an Agent kind badge when the row carries no membership role', () => {
			mount([agentBrian()], [])
			const row = screen.getByRole('link').closest('li') as HTMLElement
			expect(within(row).getByText('Agent')).toBeInTheDocument()
		})
	})

	describe('Display menu', () => {
		it('filters rows by status through the Display menu and resets the filter', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Display' }))
			await user.click(screen.getByRole('button', { name: /\+ status/i }))
			await user.click(screen.getByRole('menuitemcheckbox', { name: 'working' }))

			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /idle/i })).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Reset' }))
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
		})

		it('Reset to default clears the status filter, sort, order and grouping together', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			const strip = screen.getByRole('group', { name: 'Filter agents by status' })
			await user.click(within(strip).getByRole('button', { name: 'Working (1)' }))
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Display' }))
			await pickFromDisplayPanel(user, 'Group by', 'Kind')
			expect(screen.getByRole('heading', { name: 'Architect' })).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Reset to default' }))

			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
			expect(screen.getByRole('heading', { name: /working/i })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: 'Architect' })).not.toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'All (3)' })).toHaveAttribute(
				'aria-pressed',
				'true',
			)
		}, 10_000)

		it('groups by kind through the Display menu and back to a single list', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			await user.click(screen.getByRole('button', { name: 'Display' }))
			await pickFromDisplayPanel(user, 'Group by', 'Kind')

			// Ada → 'Researcher', Brian → 'Architect', Cy → 'Reviewer'
			expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument()
			expect(screen.getByRole('heading', { name: 'Architect' })).toBeInTheDocument()
			expect(screen.getByRole('heading', { name: 'Reviewer' })).toBeInTheDocument()

			await pickFromDisplayPanel(user, 'Group by', 'None')
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: 'Researcher' })).not.toBeInTheDocument()
			expect(screen.getAllByRole('listitem')).toHaveLength(3)
		})

		it('re-sorts rows by session count asc and desc through the Display menu', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian()], [brianRunningSession()])

			// Ada has 0 sessions, Brian has 1 — first make the ordering
			// visible by collapsing grouping, then sort by Sessions.
			await user.click(screen.getByRole('button', { name: 'Display' }))
			await pickFromDisplayPanel(user, 'Group by', 'None')
			await pickFromDisplayPanel(user, 'Sort by', 'Sessions')

			const links = screen.getAllByRole('link')
			expect(links[0]).toHaveTextContent('Ada')
			expect(links[1]).toHaveTextContent('Brian')

			await user.click(screen.getByRole('button', { name: 'Ascending' }))
			const linksDesc = screen.getAllByRole('link')
			expect(linksDesc[0]).toHaveTextContent('Brian')
			expect(linksDesc[1]).toHaveTextContent('Ada')
		})

		it('re-sorts rows by status rank asc and desc through the Display menu', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			await user.click(screen.getByRole('button', { name: 'Display' }))
			await pickFromDisplayPanel(user, 'Group by', 'None')
			await pickFromDisplayPanel(user, 'Sort by', 'Status')

			// STATUS_RANK: running < paused < idle < failed.
			const linksAsc = screen.getAllByRole('link')
			expect(linksAsc[0]).toHaveTextContent('Brian') // running
			expect(linksAsc[1]).toHaveTextContent('Ada') // idle
			expect(linksAsc[2]).toHaveTextContent('Cy') // failed

			await user.click(screen.getByRole('button', { name: 'Ascending' }))
			const linksDesc = screen.getAllByRole('link')
			expect(linksDesc[0]).toHaveTextContent('Cy')
			expect(linksDesc[1]).toHaveTextContent('Ada')
			expect(linksDesc[2]).toHaveTextContent('Brian')
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

		it('does not crash on a stale persisted status filter that is not a known bucket', async () => {
			// 'paused' is a valid portrait status but not a status-group bucket.
			// A stale blob must fail closed — empty state, never a crash through
			// an undefined STATUS_GROUP_META entry.
			mockState.__dsPersistedSettings = {
				sort: 'name',
				order: 'asc',
				groupBy: 'status',
				filters: { status: 'paused' },
			}
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			await flushHydrateAndWriteThrough()
			expect(screen.getByText('No agents in that state right now.')).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()
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
			// kind:false drops the badge; the activity and session columns remain.
			const row = screen.getByRole('link').closest('li') as HTMLElement
			expect(within(row).queryByText('Agent')).not.toBeInTheDocument()
			expect(within(row).getByText('Crunching numbers')).toBeInTheDocument()
			expect(within(row).getByText('1 session')).toBeInTheDocument()
		}, 10_000)
	})
})
