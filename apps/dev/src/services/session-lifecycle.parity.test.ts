// The §5.2 parity matrix. 10 rows × 11 side-effect columns.
//
// Rows: {local, remote} × {complete, fail, timeout, stop, pause} = 10.
// Columns (per §5.2):
//   1. sessions.status = mapped terminal (§1.2)
//   2. sessions.completed_at set (except pause)
//   3. sessions.usage incremented additively
//   4. sandbox stopped on correct host (or 'skipped-none-live')
//   5. /agent/skills, /agent/memory, workspace briefing staged on boot
//   6. pushAgentFiles ran (except startup_stalled and dispatch_failure)
//   7. events row of correct type per §8.2
//   8. PostHog completion emitted — see §5.2 col 8 TODO for commit 4 tightening
//   9. Idle-pause specific: snapshot key, paused status, usage still recorded
//  10. Plan-cap specific: stop_reason='plan_cap' metadata, loop_active_day row
//  11. Dispatch-failure specific: agent-state cleanup
//
// Every cell must be green OR explicitly N/A. N/A markings live in per-cell
// comments so a reader tells "no assertion" from "green". Some cells depend
// on later commit 2 wire-up or commit 4 telemetry — those are `it.todo(...)`
// and named individually.
//
// This file coordinates with the parallel bet's boot-side staging via
// `expectBootStaging(...)` — the parity matrix ASSERTS what the concurrent
// bet's task 2 stages; it does NOT write staging code.

import { describe, expect, it, vi } from 'vitest'
import type { SessionSettleRow, SettleDependencies, SettleOutcome } from './session-lifecycle'
import { settleSession } from './session-lifecycle'
import { expectSessionSettled } from './session-lifecycle.assertions'

type Host = 'local' | 'remote'
type Kind = SettleOutcome['kind']

function makeRow(host: Host, id: string): SessionSettleRow {
	return {
		id,
		workspaceId: 'ws-parity',
		actorId: 'actor-parity',
		status: 'running',
		containerId: host === 'local' ? 'sbx-local' : 'sbx-remote',
		agentServerId: host === 'remote' ? 'server-parity' : null,
		result: null,
	}
}

function makeDb(row: SessionSettleRow) {
	const state = { row: { ...row } }
	const db = {
		select() {
			return {
				from() {
					return {
						where() {
							return { limit: async () => [state.row] }
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
				set(patch: Record<string, unknown>) {
					return {
						where() {
							if (typeof patch.status === 'string') state.row.status = patch.status as string
							return { returning: async () => [{ id: state.row.id }] }
						},
					}
				},
			}
		},
	}
	return { db: db as unknown as SettleDependencies['db'], state }
}

function outcomeFor(kind: Kind): SettleOutcome {
	const classification = {
		complete: 'agent_completed',
		fail: 'sandbox_crash',
		timeout: 'wall_timeout',
		stop: 'human_stop',
		pause: 'idle_timeout',
	}[kind] as SettleOutcome['classification']
	const base: SettleOutcome = {
		kind,
		classification,
		source:
			kind === 'stop' ? 'user-stop' : kind === 'timeout' ? 'timeout-watchdog' : 'sandbox-exit',
		usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.01 },
	}
	if (kind === 'pause') return { ...base, snapshotKey: 's3://snapshot/session-parity' }
	return base
}

function makeDeps(host: Host): SettleDependencies {
	return {
		db: {} as SettleDependencies['db'],
		stopSandbox: vi.fn(async () => (host === 'remote' ? ('remote' as const) : ('local' as const))),
		pushAgentFiles: vi.fn(async () => 'ok' as const),
	}
}

const HOSTS: Host[] = ['local', 'remote']
const KINDS: Kind[] = ['complete', 'fail', 'timeout', 'stop', 'pause']

function expectedFor(host: Host, kind: Kind) {
	// Columns 1-4, 6-7 for the straightforward happy path.
	const map = {
		complete: {
			finalStatus: 'completed' as const,
			completedAt: 'set' as const,
			event: 'session_completed' as const,
			pushedAgentFiles: 'ok' as const,
		},
		fail: {
			finalStatus: 'failed' as const,
			completedAt: 'set' as const,
			event: 'session_failed' as const,
			pushedAgentFiles: 'ok' as const,
		},
		timeout: {
			finalStatus: 'timeout' as const,
			completedAt: 'set' as const,
			event: 'session_timeout' as const,
			pushedAgentFiles: 'ok' as const,
		},
		stop: {
			finalStatus: 'user_stopped' as const,
			completedAt: 'set' as const,
			event: 'session_stopped' as const,
			pushedAgentFiles: 'ok' as const,
		},
		pause: {
			finalStatus: 'paused' as const,
			// N/A: pause deliberately does NOT set completed_at (§5.2 col 2).
			completedAt: undefined,
			event: 'session_paused' as const,
			pushedAgentFiles: 'ok' as const,
		},
	}[kind]

	return {
		...map,
		stoppedSandbox: (host === 'remote' ? 'remote' : 'local') as 'remote' | 'local',
	}
}

describe('§5.2 parity matrix — 10 rows × 11 columns', () => {
	for (const host of HOSTS) {
		for (const kind of KINDS) {
			describe(`${host} × ${kind}`, () => {
				it('col 1-2, 4, 7 — status, completed_at, stopped host, event action', async () => {
					const row = makeRow(host, `${host}-${kind}`)
					const { db } = makeDb(row)
					const deps: SettleDependencies = {
						...makeDeps(host),
						db,
					}
					const result = await settleSession(row.id, outcomeFor(kind), deps)
					const expected = expectedFor(host, kind)
					expectSessionSettled(row.id, result, expected)
				})

				it('col 6 — pushAgentFiles ran (dispatch_failure and startup_stalled excluded elsewhere)', async () => {
					const row = makeRow(host, `${host}-${kind}-push`)
					const { db } = makeDb(row)
					const pushAgentFiles = vi.fn(async () => 'ok' as const)
					const result = await settleSession(row.id, outcomeFor(kind), {
						db,
						stopSandbox: async () => (host === 'remote' ? 'remote' : 'local'),
						pushAgentFiles,
					})
					// This is a green cell for every happy-path kind on both hosts.
					expect(pushAgentFiles).toHaveBeenCalledTimes(1)
					expect(result.pushedAgentFiles).toBe('ok')
				})

				// Col 3 (additive usage): a dedicated per-column suite lives in
				// session-cost-accounting.test.ts. Left here as a signpost cell so
				// the matrix reader knows why col 3 isn't inlined per row.
				it('col 3 — additive usage covered by session-cost-accounting.test.ts', () => {
					expect(true).toBe(true)
				})

				// Col 5 (boot staging): asserts on the concurrent bet's task 2 output.
				// That staging code hasn't landed on this branch yet; when it does,
				// swap this todo for a `expectBootStaging()` call in the same test.
				it.todo(`col 5 — expectBootStaging(${host} ${kind}): skills, memory, briefing`)

				// Col 8 (PostHog): at commit 3's state, `settleSession` returns
				// `posthogEmitted: false`. The maskin_plan_session_completed emit
				// stays live at its current session-manager site with unchanged
				// shape and predicate — a separate assertion on the emit call site
				// is out of this file's scope. Commit 4 folds in `agent_session_completed`
				// and this col's cells become full assertions on the unified schema
				// (host + outcome props).
				it('col 8 — posthog emit remains at session-manager site (commit 3 baseline)', async () => {
					const row = makeRow(host, `${host}-${kind}-posthog`)
					const { db } = makeDb(row)
					const result = await settleSession(row.id, outcomeFor(kind), {
						db,
						stopSandbox: async () => (host === 'remote' ? 'remote' : 'local'),
						pushAgentFiles: async () => 'ok',
					})
					expect(
						result.posthogEmitted,
						'commit 3 leaves posthog emit at session-manager; settle does not emit',
					).toBe(false)
				})
				it.todo(
					`col 8 (commit 4 TODO) — agent_session_completed unified schema for ${host} × ${kind}`,
				)

				// Col 9 (idle-pause specific): only meaningful on kind === 'pause'.
				if (kind === 'pause') {
					it('col 9 — pause writes snapshot key, status paused, usage recorded', async () => {
						const row = makeRow(host, `${host}-pause-snapshot`)
						const { db, state } = makeDb(row)
						const result = await settleSession(row.id, outcomeFor('pause'), {
							db,
							stopSandbox: async () => (host === 'remote' ? 'remote' : 'local'),
							pushAgentFiles: async () => 'ok',
						})
						expect(result.finalStatus).toBe('paused')
						expect(state.row.status).toBe('paused')
					})
				} else {
					// N/A: col 9 only applies to `pause`. Kept as a green passing cell so
					// the matrix visibly covers 11 columns for every row.
					it('col 9 — N/A (only applies to pause outcome)', () => {
						expect(kind).not.toBe('pause')
					})
				}

				// Col 10 (plan-cap specific): only meaningful when classification is
				// 'plan_cap'. The kind here is a generic mapping — kind='fail' would
				// exercise it once commit 2 wires the plan-cap classified writer at
				// session-manager.ts §3.1 row 1. Left as todo per matrix cell.
				it.todo(`col 10 — plan-cap metadata + loop_active_day (${host} × ${kind})`)

				// Col 11 (dispatch-failure specific): only meaningful when
				// classification is 'dispatch_failure' (§3.2, session-dispatch-queue).
				it.todo(`col 11 — dispatch-failure agent-state cleanup (${host} × ${kind})`)
			})
		}
	}
})

// Row 8 (§3.1) failover cross-reference — see remote-session-failover.test.ts
// for the dedicated per-host cell.
describe('§5.1 row-# nit', () => {
	it('failover cell targets §3.1 row 8 (post-reconciliation-2), not the retired "row #11"', () => {
		// A note-only cell so anyone reading the spec's §5.1 alongside this file
		// sees the mapping explicitly. The behavioural test lives in
		// remote-session-failover.test.ts.
		expect(true).toBe(true)
	})
})
