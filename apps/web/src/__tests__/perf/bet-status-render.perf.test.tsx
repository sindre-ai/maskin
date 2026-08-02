import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { ObjectResponse } from '@/lib/api'
import {
	type BetLike,
	type BetStatusResult,
	type BetStatusState,
	type BreaksIntoRel,
	type ChildTaskLike,
	STALLED_THRESHOLD_MS,
	buildBetStatuses,
} from '@maskin/shared'
import type { ExpandedState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { act } from '@testing-library/react'
import type { ButtonHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// Skip by default — on-demand harness. Enable with RUN_PERF=1. Matches the
// invocation named in the parent bet's guardrail AC and in the predecessor
// bet's metadata.posthog_query.
const RUN = process.env.RUN_PERF === '1'
const describePerf = RUN ? describe : describe.skip

// Router primitives touched by the Title-cell Link — stubbed as a plain
// button so cells keep their real render shape (badges, truncation, click
// handler) without pulling the router into a jsdom process.
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
		const { to: _to, params: _params, onClick, ...rest } = props
		return (
			<button
				type="button"
				{...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
				onClick={(e) => {
					if (typeof onClick === 'function') {
						;(onClick as (ev: ReactMouseEvent<HTMLButtonElement>) => void)(e)
					}
					e.preventDefault()
				}}
			>
				{children}
			</button>
		)
	},
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

// The Title cell renders AgentWorkingBadge whenever an object row has an
// `activeSessionId` — the perf fixture never sets that on bet rows, but the
// badge itself opens SSE streams if it ever mounts. Stub it to a no-op so a
// fixture drift can't turn the harness into an integration test.
vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => null,
}))

// Virtualizer window — jsdom's scroll container has zero layout, so the real
// virtualizer renders zero items and the perf measurement covers nothing.
// Mocking to a viewport-sized slice matches what a real browser paints after
// virtualization — the row-model rebuild is still O(n) over the full 1000
// bets (that's the AC's cost), but the DOM commit stays at a realistic
// viewport size instead of forcing 1000 rows into jsdom's synchronous layout
// path (which OOMs the default Node heap). 12 rows is the compact-density
// viewport the objects table opens with at typical laptop heights.
const VIEWPORT_ROWS = 12
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({ count }: { count: number }) => {
		const visible = Math.min(count, VIEWPORT_ROWS)
		return {
			getVirtualItems: () =>
				Array.from({ length: visible }, (_, i) => ({
					index: i,
					key: i,
					start: i * 48,
					size: 48,
				})),
			getTotalSize: () => count * 48,
			measureElement: () => {},
			scrollToIndex: () => {},
		}
	},
}))

const NOW = new Date('2026-08-02T12:00:00Z')
const STALLED_UPDATED_AT = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 60_000).toISOString()
const FRESH_UPDATED_AT = new Date(NOW.getTime() - 60_000).toISOString()

// Realistic mix — the objects overview typically shows a long tail of idle
// bets with a smaller working set of progressing / waiting / stalled. Weights
// sum to 1000 and cover every state so every filter value has non-empty rows.
const DISTRIBUTION: Record<BetStatusState, number> = {
	idle: 400,
	stalled: 300,
	progressing: 200,
	waiting_on_human: 100,
}

interface Fixture {
	bets: ObjectResponse[]
	betLikes: BetLike[]
	tasks: ChildTaskLike[]
	breaksIntoRels: BreaksIntoRel[]
}

function buildBet(id: string): ObjectResponse {
	return {
		id,
		workspaceId: 'ws-perf',
		type: 'bet',
		title: `Bet ${id}`,
		content: null,
		status: 'active',
		metadata: null,
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-perf',
		createdAt: FRESH_UPDATED_AT,
		updatedAt: FRESH_UPDATED_AT,
	}
}

// Shape child tasks so classifyBetStatus() lands on `state`. Faithful to the
// classifier's branches (packages/shared/src/bet-status.ts) so the fixture
// exercises the real per-bet fan-out the classifier consumes at render time.
function tasksForState(betId: string, state: BetStatusState): ChildTaskLike[] {
	const base: Omit<ChildTaskLike, 'id' | 'status'> = {
		type: 'task',
		title: `Task ${betId}`,
		driver: 'agent-perf',
		metadata: null,
		updatedAt: FRESH_UPDATED_AT,
		activeSessionId: null,
	}
	switch (state) {
		case 'progressing':
			return [
				{ ...base, id: `${betId}-t1`, status: 'in_progress', activeSessionId: `${betId}-s1` },
				{ ...base, id: `${betId}-t2`, status: 'todo' },
				{ ...base, id: `${betId}-t3`, status: 'done' },
			]
		case 'waiting_on_human':
			return [
				{
					...base,
					id: `${betId}-t1`,
					status: 'todo',
					metadata: { human_decision: true },
				},
				{ ...base, id: `${betId}-t2`, status: 'in_progress', activeSessionId: `${betId}-s1` },
				{ ...base, id: `${betId}-t3`, status: 'done' },
			]
		case 'stalled':
			return [
				{
					...base,
					id: `${betId}-t1`,
					status: 'in_progress',
					activeSessionId: null,
					updatedAt: STALLED_UPDATED_AT,
				},
				{ ...base, id: `${betId}-t2`, status: 'todo', updatedAt: STALLED_UPDATED_AT },
			]
		case 'idle':
			return [{ ...base, id: `${betId}-t1`, status: 'todo' }]
	}
}

function buildFixture(): Fixture {
	const bets: ObjectResponse[] = []
	const betLikes: BetLike[] = []
	const tasks: ChildTaskLike[] = []
	const breaksIntoRels: BreaksIntoRel[] = []
	let index = 0
	for (const [state, count] of Object.entries(DISTRIBUTION) as [BetStatusState, number][]) {
		for (let i = 0; i < count; i++) {
			const id = `bet-${state}-${i.toString().padStart(4, '0')}`
			bets.push(buildBet(id))
			betLikes.push({ id, type: 'bet', status: 'active' })
			const childTasks = tasksForState(id, state)
			for (const t of childTasks) {
				tasks.push(t)
				breaksIntoRels.push({ sourceId: id, targetId: t.id })
			}
			index++
		}
	}
	if (index !== 1000) {
		throw new Error(`fixture bet count ${index} !== 1000`)
	}
	return { bets, betLikes, tasks, breaksIntoRels }
}

// Stable references — the objects route memoizes these across renders.
// Matching that here means React can skip work triggered by identity-only
// prop churn and the timings reflect actual filter cost, not garbage.
const COLUMNS = getStaticColumns({ workspaceId: 'ws-perf', actors: [] })
const STABLE_ROW_SELECTION: RowSelectionState = {}
const STABLE_COLUMN_VIS: VisibilityState = {}
const STABLE_EXPANDED: ExpandedState = {}
const NOOP = () => {}

interface HarnessProps {
	data: ObjectResponse[]
	betStatuses: Map<string, BetStatusResult>
}

function PerfHarness({ data, betStatuses }: HarnessProps) {
	return (
		<DataTable
			data={data}
			columns={COLUMNS}
			workspaceId="ws-perf"
			rowSelection={STABLE_ROW_SELECTION}
			onRowSelectionChange={NOOP}
			columnVisibility={STABLE_COLUMN_VIS}
			onColumnVisibilityChange={NOOP}
			expanded={STABLE_EXPANDED}
			onExpandedChange={NOOP}
			meta={{
				onSort: NOOP,
				currentSort: 'createdAt',
				currentOrder: 'desc',
				betStatuses,
				showBetStatusIndicator: true,
			}}
		/>
	)
}

function percentile(samples: number[], p: number): number {
	if (samples.length === 0) return 0
	const sorted = [...samples].sort((a, b) => a - b)
	const rank = p * (sorted.length - 1)
	const lo = Math.floor(rank)
	const hi = Math.ceil(rank)
	if (lo === hi) return sorted[lo] as number
	const frac = rank - lo
	return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac
}

describePerf('bet-status-render perf harness (RUN_PERF=1)', () => {
	it('re-applies the bet-status filter over 1000 rendered bets under 100ms p95', () => {
		const { bets, betLikes, tasks, breaksIntoRels } = buildFixture()

		// Precompute once — the filter is a client-side reslice over the map, not
		// a re-classification. Mirrors the memoized `betStatuses` in the objects
		// route (apps/web/src/routes/_authed/$workspaceId/objects/index.tsx).
		const betStatuses = buildBetStatuses(betLikes, tasks, breaksIntoRels, NOW)

		// Sanity: every state has non-empty rows so the cycle below always tests
		// a non-trivial reslice. Empty renders are trivially fast and would make
		// the p95 meaningless.
		const seen = new Map<BetStatusState, number>()
		for (const result of betStatuses.values()) {
			seen.set(result.state, (seen.get(result.state) ?? 0) + 1)
		}
		for (const state of ['progressing', 'waiting_on_human', 'stalled', 'idle'] as const) {
			expect(seen.get(state) ?? 0).toBeGreaterThan(0)
		}
		expect(bets.length).toBe(1000)

		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)

		try {
			const filterCycle: BetStatusState[] = ['progressing', 'waiting_on_human', 'stalled', 'idle']

			// Precompute the filtered subsets — the filter operation itself is
			// trivially fast (Map lookup × 1000, sub-millisecond). Keeping it
			// outside the timed loop means samples reflect the render cost of
			// the reslice, which is what regresses when the classifier or the
			// row-model shape drifts.
			const subsets: Record<BetStatusState, ObjectResponse[]> = {
				progressing: bets.filter((b) => betStatuses.get(b.id)?.state === 'progressing'),
				waiting_on_human: bets.filter((b) => betStatuses.get(b.id)?.state === 'waiting_on_human'),
				stalled: bets.filter((b) => betStatuses.get(b.id)?.state === 'stalled'),
				idle: bets.filter((b) => betStatuses.get(b.id)?.state === 'idle'),
			}

			// Warmup — mount + several re-renders so React fiber caches, column
			// closures, and per-row memoized cell contexts are all steady state
			// before we start sampling. Without this, the first few iterations
			// dominate p95 and mask real regressions.
			act(() => {
				root.render(<PerfHarness data={bets} betStatuses={betStatuses} />)
			})
			for (let w = 0; w < 8; w++) {
				const wState = filterCycle[w % filterCycle.length] as BetStatusState
				const warmData = w % 2 === 0 ? subsets[wState] : bets
				act(() => {
					root.render(<PerfHarness data={warmData} betStatuses={betStatuses} />)
				})
			}

			const N = 100
			const samples: number[] = []

			for (let i = 0; i < N; i++) {
				// Alternate: half the iterations narrow to a single state, half
				// restore the full 1000 rows. Both directions are "re-apply the
				// filter" from the user's POV and both need to stay under budget.
				const narrowing = i % 2 === 0
				const state = filterCycle[Math.floor(i / 2) % filterCycle.length] as BetStatusState
				const nextData = narrowing ? subsets[state] : bets

				const start = performance.now()
				act(() => {
					root.render(<PerfHarness data={nextData} betStatuses={betStatuses} />)
				})
				samples.push(performance.now() - start)
			}

			const p50 = percentile(samples, 0.5)
			const p95 = percentile(samples, 0.95)
			const p99 = percentile(samples, 0.99)
			console.log(
				`bet-status-render.perf: N=${N} rows=${bets.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`,
			)

			expect(p95).toBeLessThan(100)
		} finally {
			act(() => {
				root.unmount()
			})
			document.body.removeChild(container)
		}
	})
})
