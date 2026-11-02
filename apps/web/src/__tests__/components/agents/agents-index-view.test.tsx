import { AgentsIndexView, type AgentsLoop } from '@/components/agents/agents-index-view'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { queryKeys } from '@/lib/query-keys'
import type { SessionStatsRow } from '@maskin/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildSessionResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter() }
})

// The row Call button mounts VoiceCallDialog, whose hook reads the workspace.
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

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

// What the actor has saved for the Agents display. Most tests run as someone who
// picked Status grouping, so the status-bucket assertions stand; `null` is a
// first visit with nothing saved.
type SavedDisplay = Record<string, unknown> | null
const SAVED_STATUS_GROUPING: SavedDisplay = { groupBy: 'status' }

function mount(
	agents: ReturnType<typeof buildActorListItem>[],
	sessions: ReturnType<typeof buildSessionResponse>[],
	stats?: SessionStatsRow[],
	loops?: AgentsLoop[],
	// 'api' leaves the cache empty so hydration reads the mocked API.
	saved: SavedDisplay | 'api' = SAVED_STATUS_GROUPING,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	if (saved !== 'api') {
		queryClient.setQueryData(queryKeys.userDisplaySettings.detail('ws-1', 'agents'), {
			object_type: 'agents',
			name: 'default',
			settings: saved ?? {},
			updated_at: '2026-05-28T10:00:00.000Z',
		})
	}
	render(
		<QueryClientProvider client={queryClient}>
			<PageHeaderProvider>
				<TitleRow />
				<WithQuery agents={agents} sessions={sessions} stats={stats} loops={loops} />
			</PageHeaderProvider>
		</QueryClientProvider>,
	)
}

// Stands in for the shared header: the view publishes its search and Display
// through PageHeader `actions`, so the test renders them where the app would.
function TitleRow() {
	const { actions, title, subtitle } = usePageHeader()
	return (
		<div data-testid="title-row">
			<h1>{title}</h1>
			<span data-testid="subtitle">{subtitle}</span>
			{actions}
		</div>
	)
}

// The route owns the search text; the input itself sits in the title row.
function WithQuery(props: {
	agents: ReturnType<typeof buildActorListItem>[]
	sessions: ReturnType<typeof buildSessionResponse>[]
	stats?: SessionStatsRow[]
	loops?: AgentsLoop[]
}) {
	const [query, setQuery] = useState('')
	return <AgentsIndexView workspaceId="ws-1" {...props} query={query} onQueryChange={setQuery} />
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
		await user.click(screen.getByRole('button', { name: /^Display/ }))
	}
	// The picker row is itself the dropdown trigger (label left, value right).
	await user.click(screen.getByText(label))
	await user.click(screen.getByRole('menuitem', { name: option }))
}

function resetMockState() {
	mockState.__dsUpsertCalls = 0
	mockState.__dsLastUpsertBody = null
	mockState.__dsPersistedSettings = {}
}

beforeEach(resetMockState)

describe('AgentsIndexView', () => {
	describe('search', () => {
		it('sits in the title row and narrows the list by typed words', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian()], [])
			const title = within(screen.getByTestId('title-row'))
			await user.type(title.getByRole('searchbox', { name: 'Search agents' }), 'architect')
			expect(screen.getByText('Brian')).toBeInTheDocument()
			expect(screen.queryByText('Ada')).not.toBeInTheDocument()
			await user.type(title.getByRole('searchbox', { name: 'Search agents' }), ' zzz')
			expect(screen.getByText('No agents match.')).toBeInTheDocument()
		})
	})

	describe('title row', () => {
		afterEach(() => {
			vi.restoreAllMocks()
		})

		it('publishes the title and no count line', () => {
			mount([agentAda(), agentBrian()], [])
			expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agents')
			expect(screen.getByTestId('subtitle')).toBeEmptyDOMElement()
		})
	})

	describe('column header', () => {
		it('labels the columns above the rows', () => {
			mount([agentAda()], [])
			for (const label of ['Agent', 'Team', 'Latest', 'Sessions', 'Status']) {
				// 'Agent' also appears as the kind badge, hence getAll.
				expect(screen.getAllByText(label, { selector: 'span' }).length).toBeGreaterThan(0)
			}
		})
	})

	describe('team', () => {
		const loops: AgentsLoop[] = [
			{ name: 'Zeta flow', agentIds: ['agent-ada', 'agent-brian'] },
			{ name: 'Alpha flow', agentIds: ['agent-brian'] },
		]

		it('shows the first flow A to Z as the team, else No team', () => {
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			// Each name is on its chip and in the Team column.
			expect(screen.getAllByText('Alpha flow').length).toBeGreaterThan(1)
			expect(screen.getAllByText('Zeta flow').length).toBeGreaterThan(1)
			expect(screen.getAllByText('No team').length).toBeGreaterThan(1)
		})

		it('groups by team by default when nothing is saved, rows A to Z inside a group', async () => {
			mount([agentCy(), agentBrian(), agentAda()], [], undefined, loops, null)
			const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
			expect(headings).toEqual(['Alpha flow', 'Zeta flow', 'No team'])
			// Zeta flow holds Ada only (Brian's first flow is Alpha); No team holds Cy.
			const links = screen.getAllByRole('link').map((l) => l.textContent ?? '')
			expect(links[0]).toContain('Brian')
			expect(links[1]).toContain('Ada')
			expect(links[2]).toContain('Cy')
		})

		it('keeps a saved Status grouping instead of the Team default', () => {
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops, { groupBy: 'status' })
			expect(screen.getByRole('heading', { name: /idle/i })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: 'Alpha flow' })).not.toBeInTheDocument()
		})

		it('groups by team with the catch-all last', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			await pickFromDisplayPanel(user, 'Group by', 'Team')
			const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
			expect(headings).toEqual(['Alpha flow', 'Zeta flow', 'No team'])
		})
	})

	describe('team chips and pills', () => {
		const loops: AgentsLoop[] = [
			{ name: 'Zeta flow', agentIds: ['agent-ada', 'agent-brian'] },
			{ name: 'Alpha flow', agentIds: ['agent-brian'] },
		]
		const strip = () => screen.getByRole('group', { name: 'Filter agents by team' })

		it('draws one chip per team with counts, the catch-all last', () => {
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			const names = within(strip())
				.getAllByRole('button')
				.map((b) => b.getAttribute('aria-label'))
			expect(names).toEqual(['Alpha flow (1)', 'Zeta flow (1)', 'No team (1)'])
		})

		it('draws only the catch-all chip when no flow has an agent', () => {
			mount([agentAda()], [], undefined, [])
			const names = within(strip())
				.getAllByRole('button')
				.map((b) => b.getAttribute('aria-label'))
			expect(names).toEqual(['No team (1)'])
		})

		it('filters by a team chip, shows a pill and removes it with its x', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			await user.click(within(strip()).getByRole('button', { name: 'Zeta flow (1)' }))
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Brian/ })).not.toBeInTheDocument()
			expect(screen.getByText('Team:')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Remove Team filter' }))
			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.queryByText('Team:')).not.toBeInTheDocument()
		})

		it('toggles a team chip off by pressing it again', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			const chip = () => within(strip()).getByRole('button', { name: 'Zeta flow (1)' })
			await user.click(chip())
			expect(chip()).toHaveAttribute('aria-pressed', 'true')
			await user.click(chip())
			expect(chip()).toHaveAttribute('aria-pressed', 'false')
			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
		})

		it('offers Clear all only with two active filters and clears both', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()], undefined, loops)
			await user.click(within(strip()).getByRole('button', { name: 'Alpha flow (1)' }))
			expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()

			const statuses = screen.getByRole('group', { name: 'Filter agents by status' })
			await user.click(within(statuses).getByRole('button', { name: 'Working (1)' }))
			await user.click(screen.getByRole('button', { name: 'Clear all' }))

			expect(screen.queryByText('Team:')).not.toBeInTheDocument()
			expect(screen.queryByText('Status:')).not.toBeInTheDocument()
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
		})

		it('has a Team row in the Display menu that drives the same filter', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [], undefined, loops)
			await user.click(screen.getByRole('button', { name: /^Display/ }))
			const teamRow = screen.getByRole('button', { name: 'Team filter, All' })
			await user.click(teamRow)
			await user.click(
				within(teamRow.parentElement as HTMLElement).getByRole('button', { name: /^Zeta flow/ }),
			)
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Brian/ })).not.toBeInTheDocument()
		})
	})

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

		// Mockup 2320 — the note is the only thing explaining a group; hiding it
		// below `sm` left mobile with a bare label and a number.
		it('keeps the group note on one truncated line at every width', () => {
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])
			const note = screen.getByText('Agents with a session in progress')
			expect(note.className).toContain('truncate')
			expect(note.className).not.toContain('hidden')
		})
	})

	// Mockup 2333 — "what it's doing now" is a desktop column, but it shared no
	// breakpoint with the sessions count, so 768px showed a name and a status.
	describe('row columns', () => {
		it('reveals the activity and session columns at the same breakpoint', () => {
			mount([agentBrian()], [brianRunningSession()])
			const [mobileLatest, activity] = screen.getAllByText('Crunching numbers')
			const row = screen.getByRole('link', { name: /Brian/ }).closest('li') as HTMLElement
			const sessions = within(row).getByText('1', { selector: 'span.tabular-nums' })
			expect(activity.className).toContain('md:block')
			expect(mobileLatest.className).toContain('md:hidden')
			expect(sessions.className).toContain('md:block')
		})

		it('reads the session count from the stats, not from the recent sessions', () => {
			mount(
				[agentBrian()],
				[buildSessionResponse({ id: 'a', actorId: 'agent-brian', status: 'running' })],
				[
					{
						actor_id: 'agent-brian',
						total: 59_500,
						active: 1,
						total_cost_usd: 1234.5,
						last_30d_cost_usd: 99.25,
						latest_status: 'running',
						latest_session_at: '2026-10-29T07:00:00.000Z',
					},
				],
			)
			const row = screen.getByRole('link').closest('li') as HTMLElement
			expect(within(row).getByText('59500')).toBeInTheDocument()
		})

		it('puts an agent with no recent session under Failed when its latest run in the stats failed', () => {
			mount(
				[agentBrian()],
				[],
				[
					{
						actor_id: 'agent-brian',
						total: 7,
						active: 0,
						total_cost_usd: 0,
						last_30d_cost_usd: 0,
						latest_status: 'failed',
						latest_session_at: '2026-09-01T07:00:00.000Z',
					},
				],
			)
			const failed = screen.getByRole('heading', { name: /failed/i })
			expect(failed.closest('div')).toHaveTextContent('1')
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
	})

	describe('rows', () => {
		it('renders the whole row as one link with outcome, activity, count and pill', () => {
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
			// One link covering the whole row, not just the name (mockup 15).
			const link = screen.getByRole('link')
			const row = link.closest('li') as HTMLElement
			expect(link).toHaveTextContent('Bob')
			expect(within(row).queryByText('member')).not.toBeInTheDocument()
			expect(within(row).getByText('Architect')).toBeInTheDocument()
			expect(within(row).getAllByText('Standing by')[0]).toBeInTheDocument()
			expect(within(row).getByText('2')).toBeInTheDocument()
			expect(within(row).getByText('Idle')).toBeInTheDocument()
		})

		// Mockup 2327: rows are flat, separated by the quietest hairline in the
		// palette. A bordered card around each group turned one column of agents
		// into a stack of panels.
		it('draws rows as an unframed column separated by the subtle hairline', () => {
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			for (const link of screen.getAllByRole('link')) {
				const row = link.closest('li') as HTMLElement
				expect(row.className).toContain('border-border-subtle')
				expect(row.parentElement?.className ?? '').not.toContain('border-border')
			}
		})

		// Mockup 15: a pill with a dot and the status word; a working agent's is tinted.
		it('renders the row status as a pill', () => {
			mount([agentBrian()], [brianRunningSession()])
			const status = screen.getByText('Working', { selector: 'span.rounded-full' })
			expect(status.className).toContain('bg-muted')
		})

		it('gives a failed agent See why instead of Call', () => {
			mount([agentCy()], [])
			expect(screen.getByRole('link', { name: 'See why' })).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Call Cy' })).not.toBeInTheDocument()
		})
	})

	describe('Display menu', () => {
		it('filters rows by status through the Display menu and resets the filter', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian()], [brianRunningSession()])
			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /^Display/ }))
			// The panel's Status row expands into its buckets (mockup 2304). The
			// chip strip's own Working control carries its count in the name, so
			// the bare 'Working' here can only be the panel option.
			const statusRow = screen.getByRole('button', { name: 'Status filter, All' })
			await user.click(statusRow)
			await user.click(
				within(statusRow.parentElement as HTMLElement).getByRole('button', { name: /^Working/ }),
			)

			expect(screen.getByRole('link', { name: /Brian/ })).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /idle/i })).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Reset filters' }))
			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
		})

		it('Reset all clears the status filter, sort, order and grouping together', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			const strip = screen.getByRole('group', { name: 'Filter agents by status' })
			await user.click(within(strip).getByRole('button', { name: 'Working (1)' }))
			expect(screen.queryByRole('link', { name: /Ada/ })).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /^Display/ }))
			await pickFromDisplayPanel(user, 'Group by', 'Kind')
			expect(screen.getByRole('heading', { name: 'Architect' })).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /Reset display/ }))

			expect(screen.getByRole('link', { name: /Ada/ })).toBeInTheDocument()
			// Back to the default grouping, which is Team (no flows here: one catch-all).
			expect(screen.getByRole('heading', { name: 'No team' })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: 'Architect' })).not.toBeInTheDocument()
			expect(within(strip).getByRole('button', { name: 'All (3)' })).toHaveAttribute(
				'aria-pressed',
				'true',
			)
		}, 10_000)

		it('groups by kind through the Display menu and back to a single list', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			await user.click(screen.getByRole('button', { name: /^Display/ }))
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
			await user.click(screen.getByRole('button', { name: /^Display/ }))
			await pickFromDisplayPanel(user, 'Group by', 'None')
			await pickFromDisplayPanel(user, 'Sort by', 'Sessions')

			const links = screen.getAllByRole('link')
			expect(links[0]).toHaveTextContent('Ada')
			expect(links[1]).toHaveTextContent('Brian')

			await user.click(screen.getByRole('button', { name: /^Order, ascending/ }))
			const linksDesc = screen.getAllByRole('link')
			expect(linksDesc[0]).toHaveTextContent('Brian')
			expect(linksDesc[1]).toHaveTextContent('Ada')
		})

		it('re-sorts rows by status rank asc and desc through the Display menu', async () => {
			const user = userEvent.setup()
			mount([agentAda(), agentBrian(), agentCy()], [brianRunningSession()])

			await user.click(screen.getByRole('button', { name: /^Display/ }))
			await pickFromDisplayPanel(user, 'Group by', 'None')
			await pickFromDisplayPanel(user, 'Sort by', 'Status')

			// STATUS_RANK: running < paused < idle < failed.
			const linksAsc = screen.getAllByRole('link', { name: /Ada|Brian|Cy/ })
			expect(linksAsc[0]).toHaveTextContent('Brian') // running
			expect(linksAsc[1]).toHaveTextContent('Ada') // idle
			expect(linksAsc[2]).toHaveTextContent('Cy') // failed

			await user.click(screen.getByRole('button', { name: /^Order, ascending/ }))
			const linksDesc = screen.getAllByRole('link', { name: /Ada|Brian|Cy/ })
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
			mount([agentAda(), agentBrian()], [brianRunningSession()], undefined, undefined, 'api')
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
			mount([agentAda(), agentBrian()], [brianRunningSession()], undefined, undefined, 'api')
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
			mount([agentAda(), agentBrian()], [brianRunningSession()], undefined, undefined, 'api')
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
			mount(
				[agentAda(), agentBrian(), agentCy()],
				[brianRunningSession()],
				undefined,
				undefined,
				'api',
			)
			await flushHydrateAndWriteThrough()
			expect(screen.getByRole('heading', { name: /working/i })).toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /idle/i })).not.toBeInTheDocument()
			expect(screen.queryByRole('heading', { name: /failed/i })).not.toBeInTheDocument()
			// The activity and session columns remain.
			const row = screen.getByRole('link', { name: /Brian/ }).closest('li') as HTMLElement
			expect(within(row).getAllByText('Crunching numbers')[0]).toBeInTheDocument()
			expect(within(row).getByText('1', { selector: 'span.tabular-nums' })).toBeInTheDocument()
		}, 10_000)
	})
})

describe('AgentsIndexView — row Call button', () => {
	it('gives every agent row a Call button, beside the row link and not inside it', () => {
		mount([agentAda(), agentBrian()], [])
		const call = screen.getByRole('button', { name: 'Call Ada' })
		expect(call).toHaveTextContent('Call')
		expect(screen.getByRole('button', { name: 'Call Brian' })).toBeInTheDocument()
		// A button nested in the row's anchor is invalid markup and would navigate.
		expect(screen.getByRole('link', { name: /Ada/ })).not.toContainElement(call)
		// Always visible (v11): no hover reveal on any width.
		expect(call.className).not.toContain('opacity-0')
	})

	it('has no Voice filter chip', () => {
		mount([agentAda(), agentBrian()], [])
		expect(screen.queryByRole('button', { name: /^Voice/ })).not.toBeInTheDocument()
	})
})
