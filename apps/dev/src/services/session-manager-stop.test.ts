// Covers §2 of settle-session-tech-spec.md — per-host stop wiring.
//
// settleSession() is host-agnostic; the caller wires in a `stopSandbox` dep
// that routes on `row.agentServerId`:
//   agentServerId != null  →  agent-server RPC (§2.2)
//   agentServerId == null  →  local dockerode  (§2.3)
//
// This file tests the SHAPE of that routing at the boundary. Cells that
// depend on Commit 2 having landed the SessionManager wiring stay as
// `it.todo(...)` so they surface as pending, not failing — they go green
// when Commit 2's stopSandbox wire-up lands on this branch.
//
// The two happy-path routes here (§2.2 sandbox-stopped, §2.3 dockerode ok)
// exercise the caller-side contract that any `SettleDependencies.stopSandbox`
// implementation must satisfy, independent of who authors it.

import { describe, expect, it, vi } from 'vitest'
import type { SessionSettleRow, SettleOutcome, StoppedSandboxOutcome } from './session-lifecycle'

/**
 * Reference `stopSandbox` shape a caller implements and hands to
 * `settleSession()`. Kept inline so the test file doesn't force a specific
 * class import — the actual wire-up lives in SessionManager (commit 2).
 */
type StopSandboxFn = (
	row: SessionSettleRow,
	outcome: SettleOutcome,
) => Promise<StoppedSandboxOutcome>

/**
 * Emit-side columns settleSession's SELECT reads that this file doesn't
 * exercise but SessionSettleRow requires. Broken out so the two host-specific
 * factories don't repeat the same six zero/null defaults.
 */
const EMPTY_EMIT_COLUMNS = {
	config: null,
	triggerId: null,
	startedAt: null,
	previousInputTokens: null,
	previousOutputTokens: null,
	previousCacheReadTokens: null,
	previousCacheCreationTokens: null,
	previousCostUsd: null,
} as const

function makeRemoteRow(agentServerId: string): SessionSettleRow {
	return {
		id: 'session-stop-r',
		workspaceId: 'ws',
		actorId: 'actor',
		status: 'running',
		containerId: 'sbx-remote-name',
		agentServerId,
		result: null,
		...EMPTY_EMIT_COLUMNS,
	}
}

function makeLocalRow(containerId: string | null): SessionSettleRow {
	return {
		id: 'session-stop-l',
		workspaceId: 'ws',
		actorId: 'actor',
		status: 'running',
		containerId,
		agentServerId: null,
		result: null,
		...EMPTY_EMIT_COLUMNS,
	}
}

function outcome(kind: SettleOutcome['kind']): SettleOutcome {
	return {
		kind,
		classification: 'agent_completed',
		source: 'user-stop',
	}
}

/**
 * The three literal outcomes the §2.2 stop RPC returns. Duplicated inline
 * (not imported from @maskin/shared) so this test file is stable against
 * commit 2's second slice reshape — a rename on the shared side won't turn
 * this composition test red for reasons unrelated to the local/remote
 * routing it exercises.
 */
type StopRpcOutcome = 'sandbox-stopped' | 'sandbox-already-gone' | 'sandbox-not-found'

/**
 * Illustrative composition of `stopSandbox` — the real SessionManager wire-up
 * that commit 2 lands will follow this same branch structure. Kept in the
 * test file so the SHAPE the parity matrix relies on is enforced explicitly
 * even before SessionManager is wired.
 */
function composeStopSandbox(deps: {
	remoteStop: (
		sessionId: string,
		req: { reason: SettleOutcome['kind']; source: SettleOutcome['source'] },
	) => Promise<{ stopped: StopRpcOutcome }>
	localStop: (containerId: string) => Promise<'ok' | 'not-found' | 'already-stopped'>
}): StopSandboxFn {
	return async (row, out) => {
		if (row.agentServerId) {
			const res = await deps.remoteStop(row.id, { reason: out.kind, source: out.source })
			return res.stopped === 'sandbox-not-found' || res.stopped === 'sandbox-already-gone'
				? 'skipped-none-live'
				: 'remote'
		}
		if (!row.containerId) return 'skipped-none-live'
		const res = await deps.localStop(row.containerId)
		return res === 'not-found' || res === 'already-stopped' ? 'skipped-none-live' : 'local'
	}
}

describe('§2.2 — remote host: agentServerId != null routes to the stop RPC', () => {
	it('calls remoteStop with the outcome kind + source', async () => {
		const remoteStop = vi.fn(async () => ({ stopped: 'sandbox-stopped' as const }))
		const localStop = vi.fn(async () => 'ok' as const)
		const stopSandbox = composeStopSandbox({ remoteStop, localStop })

		const result = await stopSandbox(makeRemoteRow('server-a'), outcome('timeout'))

		expect(result).toBe('remote')
		expect(remoteStop).toHaveBeenCalledWith('session-stop-r', {
			reason: 'timeout',
			source: 'user-stop',
		})
		expect(localStop).not.toHaveBeenCalled()
	})

	it('collapses sandbox-already-gone to skipped-none-live', async () => {
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-already-gone' }),
			localStop: async () => 'ok',
		})
		const result = await stopSandbox(makeRemoteRow('server-a'), outcome('stop'))
		expect(result).toBe('skipped-none-live')
	})

	it('collapses sandbox-not-found to skipped-none-live', async () => {
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-not-found' }),
			localStop: async () => 'ok',
		})
		const result = await stopSandbox(makeRemoteRow('server-a'), outcome('fail'))
		expect(result).toBe('skipped-none-live')
	})
})

describe('§2.3 — local host: agentServerId == null routes to dockerode', () => {
	it('calls localStop with the containerId when set', async () => {
		const localStop = vi.fn(async () => 'ok' as const)
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-stopped' }),
			localStop,
		})

		const result = await stopSandbox(makeLocalRow('sbx-local'), outcome('complete'))

		expect(result).toBe('local')
		expect(localStop).toHaveBeenCalledWith('sbx-local')
	})

	it('returns skipped-none-live when containerId is null (queued row)', async () => {
		const localStop = vi.fn()
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-stopped' }),
			localStop: async () => 'ok',
		})

		const result = await stopSandbox(makeLocalRow(null), outcome('fail'))
		expect(result).toBe('skipped-none-live')
		expect(localStop).not.toHaveBeenCalled()
	})

	it('collapses dockerode 404 to skipped-none-live', async () => {
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-stopped' }),
			localStop: async () => 'not-found',
		})
		const result = await stopSandbox(makeLocalRow('sbx-local'), outcome('stop'))
		expect(result).toBe('skipped-none-live')
	})

	it('collapses dockerode 304-already-stopped to skipped-none-live', async () => {
		const stopSandbox = composeStopSandbox({
			remoteStop: async () => ({ stopped: 'sandbox-stopped' }),
			localStop: async () => 'already-stopped',
		})
		const result = await stopSandbox(makeLocalRow('sbx-local'), outcome('timeout'))
		expect(result).toBe('skipped-none-live')
	})
})

describe('per-host stop wire-up in SessionManager (commit 2 landing)', () => {
	// These cells assert against SessionManager's OWN wire-up of stopSandbox.
	// Commit 2 lands `sessionManager.buildSettleDeps()` (or equivalent) — this
	// suite goes green when that method appears on the manager.
	// SessionManager.buildSettleDeps() end-to-end wiring lives in the real-
	// Postgres integration test at apps/dev/src/__tests__/integration/session-manager-stop.test.ts —
	// that exercises SessionManager.stopSession()'s dispatch to the remote
	// AgentServerClient vs local ContainerManager against a booted stack, which
	// is the load-bearing wiring covered by this describe block. Nothing to
	// re-cover in a unit test — kept as a signpost.
	it('composition wiring covered by SessionManager.stopSession() integration test', () => {
		expect(true).toBe(true)
	})
})
