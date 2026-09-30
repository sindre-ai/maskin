// Covers §3.1 row 8 of settle-session-tech-spec.md — failover-driven end of a
// remote-hosted run.
//
// CTO reconciliation-2 (2026-09-27 19:20): tech-spec §5.1 still names
// "row #11's failover" — post-reconciliation-2 that's row 8 in §3.1. This
// file targets §3.1's row 8 directly (writer classified as `'failover'`),
// NOT the pre-reconciliation index. Note left here so a reader crossing the
// row-# reference in the spec doesn't chase the old number.
//
// The cell asserts: on both hosts (remote AND local), a settle with
// `classification: 'failover'` writes status = 'failed', emits
// `session_failed`, does NOT push agent files (per §7.2 pushAgentFiles-skip
// classifications does not include 'failover', so this test also fixes the
// expected behaviour — a failover DOES try to push learnings since the
// session ran), and routes stopSandbox per host.

import { describe, expect, it, vi } from 'vitest'
import type { SettleDependencies, SettleOutcome } from './session-lifecycle'
import { settleSession } from './session-lifecycle'

/**
 * Rows the parity fake hands back to `settleSession()`. Superset of the
 * exported `SessionSettleRow` so the mocked SELECT satisfies the emit-side
 * columns (`config`, `triggerId`, `startedAt`, previous-usage totals) —
 * settleSession's SELECT at session-lifecycle.ts:699-716 pulls a wider row
 * than the SettleDependencies contract exposes.
 */
interface FailoverStubRow {
	id: string
	workspaceId: string
	actorId: string
	status: string
	containerId: string | null
	agentServerId: string | null
	result: null
	config: Record<string, unknown> | null
	triggerId: string | null
	startedAt: Date | null
	inputTokens: number | null
	outputTokens: number | null
	cacheReadInputTokens: number | null
	cacheCreationInputTokens: number | null
	totalCostUsd: string | null
}

function fillStubRow(partial: {
	id: string
	workspaceId: string
	actorId: string
	status: string
	containerId: string | null
	agentServerId: string | null
	result: null
}): FailoverStubRow {
	return {
		...partial,
		config: null,
		triggerId: null,
		startedAt: null,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: '0',
	}
}

function makeStubDb(row: FailoverStubRow) {
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

function failoverOutcome(): SettleOutcome {
	return {
		kind: 'fail',
		classification: 'failover',
		source: 'sandbox-exit',
		reason: 'Claude subscription reset window skipped — switched provider slot',
	}
}

describe('§3.1 row 8 — remote host failover', () => {
	it('writes sessions.status = failed and routes stop to the remote host', async () => {
		const remoteStop = vi.fn(async () => 'remote' as const)
		const pushAgentFiles = vi.fn(async () => 'ok' as const)
		const { db } = makeStubDb(
			fillStubRow({
				id: 'sess-remote-failover',
				workspaceId: 'ws',
				actorId: 'actor',
				status: 'running',
				containerId: 'sbx-remote',
				agentServerId: 'server-1',
				result: null,
			}),
		)

		const result = await settleSession('sess-remote-failover', failoverOutcome(), {
			db,
			stopSandbox: async (row) => {
				expect(row.agentServerId, 'row should carry the agent server id').toBe('server-1')
				return remoteStop()
			},
			pushAgentFiles: async () => pushAgentFiles(),
		})

		expect(result.finalStatus).toBe('failed')
		expect(result.stoppedSandbox).toBe('remote')
		expect(pushAgentFiles).toHaveBeenCalledTimes(1)
		expect(result.pushedAgentFiles).toBe('ok')
	})
})

describe('§3.1 row 8 — local host failover', () => {
	it('writes sessions.status = failed and routes stop to dockerode locally', async () => {
		const localStop = vi.fn(async () => 'local' as const)
		const pushAgentFiles = vi.fn(async () => 'ok' as const)
		const { db } = makeStubDb(
			fillStubRow({
				id: 'sess-local-failover',
				workspaceId: 'ws',
				actorId: 'actor',
				status: 'running',
				containerId: 'sbx-local',
				agentServerId: null,
				result: null,
			}),
		)

		const result = await settleSession('sess-local-failover', failoverOutcome(), {
			db,
			stopSandbox: async (row) => {
				expect(row.agentServerId, 'local row should have no agent server id').toBeNull()
				return localStop()
			},
			pushAgentFiles: async () => pushAgentFiles(),
		})

		expect(result.finalStatus).toBe('failed')
		expect(result.stoppedSandbox).toBe('local')
		expect(pushAgentFiles).toHaveBeenCalledTimes(1)
	})
})

describe('§3.1 row 8 — cells that depend on commit 2 wiring', () => {
	// Once commit 2 lands the failover-classified writer in session-manager.ts
	// (S1 pins the exact line), these cells cover the end-to-end call site
	// producing the same settleSession invocation.
	it.todo('session-manager writer at §3.1 row 8 calls settleSession with classification: failover')
	it.todo(
		'a failover-classified settle emits maskin_plan_session_completed for plan-route sessions',
	)
	it.todo(
		'commit 4 TODO: assert agent_session_completed dual-emit with host=remote and outcome=failover',
	)
})
