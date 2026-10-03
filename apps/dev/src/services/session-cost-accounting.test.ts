// Covers §1.4 of settle-session-tech-spec.md — additive usage accounting.
//
// Every settleSession() call must ADD to whatever the row already carries,
// never overwrite. Two writers arriving with partial usage both contribute.
// The anti-drop contract closes the "usage lost on timeout" failure mode
// that motivated the whole bet.
//
// The strategy here: settleSession() builds an additive UPDATE via a `sql`
// fragment shaped `COALESCE(<col>, 0) + <delta>`. We test the CONTRACT by
// capturing the `.set(...)` patch settleSession hands to Drizzle and
// verifying that (a) usage columns are `sql` fragments (never plain
// overwrites), and (b) omitted usage leaves those columns untouched.

import { describe, expect, it, vi } from 'vitest'
import type { SettleDependencies, SettleOutcome, SettleUsage } from './session-lifecycle'
import { settleSession } from './session-lifecycle'

interface CapturedUpdate {
	setPatch: Record<string, unknown>
}

interface StubRow {
	id: string
	workspaceId: string
	actorId: string
	status: string
	containerId: string | null
	agentServerId: string | null
	result: null
}

function makeStub(row: StubRow) {
	const captured: CapturedUpdate[] = []
	const db = {
		select() {
			return {
				from() {
					return {
						where() {
							return { limit: async () => [row] }
						},
					}
				},
			}
		},
		transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
		insert() {
			return { values: async () => undefined }
		},
		update() {
			return {
				set(setPatch: Record<string, unknown>) {
					captured.push({ setPatch })
					return {
						where() {
							return { returning: async () => [{ id: row.id }] }
						},
					}
				},
			}
		},
	}
	return { db: db as unknown as SettleDependencies['db'], captured }
}

function makeDeps(dbStub: SettleDependencies['db']): SettleDependencies {
	return {
		db: dbStub,
		stopSandbox: vi.fn(async () => 'skipped-none-live' as const),
		pushAgentFiles: vi.fn(async () => 'ok' as const),
	}
}

function baseRow(): StubRow {
	return {
		id: 'session-cost-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		status: 'running',
		containerId: null,
		agentServerId: null,
		result: null,
	}
}

function outcome(kind: SettleOutcome['kind'], usage?: SettleUsage): SettleOutcome {
	const classification = {
		complete: 'agent_completed',
		fail: 'sandbox_crash',
		timeout: 'wall_timeout',
		stop: 'human_stop',
		pause: 'idle_timeout',
	}[kind] as SettleOutcome['classification']
	return {
		kind,
		classification,
		source: 'sandbox-exit',
		usage,
	}
}

/**
 * True when the value looks like a Drizzle `sql` fragment (as opposed to a
 * plain literal or a Date). settleSession emits usage-column patches as
 * `sql\`COALESCE(<col>, 0) + <delta>\`` — testing that this shape is present
 * on the emitted patch is the additive-contract assertion.
 */
function isSqlFragment(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return 'queryChunks' in v || 'sql' in v || 'shouldInlineParams' in v
}

describe('settleSession — §1.4 additive usage accounting (setPatch contract)', () => {
	it('emits a sql fragment for inputTokens when usage carries it (complete outcome)', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			outcome('complete', { inputTokens: 100, outputTokens: 250, costUsd: 0.01 }),
			makeDeps(db),
		)
		expect(captured).toHaveLength(1)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status, 'terminal status literal').toBe('completed')
		expect(isSqlFragment(patch.inputTokens), 'inputTokens is a sql fragment').toBe(true)
		expect(isSqlFragment(patch.outputTokens), 'outputTokens is a sql fragment').toBe(true)
		expect(isSqlFragment(patch.totalCostUsd), 'totalCostUsd is a sql fragment').toBe(true)
	})

	it('emits sql fragments for cache tokens when usage carries them (stop outcome)', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			outcome('stop', {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 30,
				cacheCreationTokens: 45,
			}),
			makeDeps(db),
		)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status).toBe('user_stopped')
		expect(isSqlFragment(patch.cacheReadInputTokens)).toBe(true)
		expect(isSqlFragment(patch.cacheCreationInputTokens)).toBe(true)
	})

	it('emits usage sql fragments on pause (idle-pause records usage per §5.2 col 9)', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			{
				kind: 'pause',
				classification: 'idle_timeout',
				source: 'idle-watcher',
				snapshotKey: 's3://snap/session-cost-1',
				usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
			},
			makeDeps(db),
		)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status).toBe('paused')
		expect(isSqlFragment(patch.inputTokens)).toBe(true)
		expect(isSqlFragment(patch.outputTokens)).toBe(true)
	})

	it('emits usage sql fragments for a timeout outcome (partial writer)', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			outcome('timeout', { inputTokens: 60, outputTokens: 20, costUsd: 0.005 }),
			makeDeps(db),
		)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status).toBe('timeout')
		expect(isSqlFragment(patch.inputTokens)).toBe(true)
		expect(isSqlFragment(patch.outputTokens)).toBe(true)
		expect(isSqlFragment(patch.totalCostUsd)).toBe(true)
	})

	it('omits usage-column keys entirely when the outcome carries no usage', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession('session-cost-1', outcome('complete'), makeDeps(db))
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status).toBe('completed')
		// Absence of these keys is the anti-overwrite contract: settleSession
		// leaves the columns alone rather than writing a plain literal that
		// would clobber whatever the row already carries.
		expect('inputTokens' in patch, 'no inputTokens overwrite when usage omitted').toBe(false)
		expect('outputTokens' in patch, 'no outputTokens overwrite when usage omitted').toBe(false)
		expect('totalCostUsd' in patch, 'no totalCostUsd overwrite when usage omitted').toBe(false)
	})

	it('accepts a fail outcome carrying only inputTokens (partial writer contract)', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			outcome('fail', { inputTokens: 500, outputTokens: 0 }),
			makeDeps(db),
		)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.status).toBe('failed')
		expect(isSqlFragment(patch.inputTokens)).toBe(true)
		// Zero output tokens should still emit as a sql fragment — a partial
		// writer's zero is still a value the row must record additively.
		expect(isSqlFragment(patch.outputTokens)).toBe(true)
	})

	it('sets completedAt on every terminal write except pause (§5.2 col 2)', async () => {
		for (const kind of ['complete', 'fail', 'timeout', 'stop'] as const) {
			const { db, captured } = makeStub(baseRow())
			await settleSession('session-cost-1', outcome(kind), makeDeps(db))
			const patch = captured[0]?.setPatch as Record<string, unknown>
			expect(patch.completedAt, `completedAt set for ${kind}`).toBeInstanceOf(Date)
		}
	})

	it('idle-pause writes the snapshot key onto snapshotPath', async () => {
		const { db, captured } = makeStub(baseRow())
		await settleSession(
			'session-cost-1',
			{
				kind: 'pause',
				classification: 'idle_timeout',
				source: 'idle-watcher',
				snapshotKey: 's3://snap/x',
			},
			makeDeps(db),
		)
		const patch = captured[0]?.setPatch as Record<string, unknown>
		expect(patch.snapshotPath).toBe('s3://snap/x')
	})
})
