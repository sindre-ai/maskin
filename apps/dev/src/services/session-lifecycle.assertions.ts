// Shared assertion helpers for the parity + per-cell tests around
// `settleSession()`. Kept as a runtime module (not a test file) so multiple
// test files can import the same shape.
//
// Spec: settle-session-tech-spec.md §5.4.
//
// The helpers are host-agnostic. They speak to what `settleSession()` returns
// (a `SettleResult`) and what shape a session row and its `events` row take
// after the call. Callers stage their own `SettleDependencies` — mocked or
// real-Postgres — so the same helpers work in `apps/dev/src/services/*.test.ts`
// and in the integration harness under `apps/dev/src/__tests__/integration/`.

import { expect } from 'vitest'
import type {
	FinalStatus,
	PushedAgentFilesOutcome,
	SettleResult,
	StoppedSandboxOutcome,
} from './session-lifecycle'

/**
 * The set of side-effect columns the parity matrix asserts on. Each field is
 * optional so a test can omit N/A cells (per-cell comments explain why the
 * cell is N/A vs. green — see the parity file).
 */
export interface ExpectedSessionSettled {
	finalStatus: FinalStatus
	/** 'set' means row.completedAt !== null. 'null' means row.completedAt === null (pause). */
	completedAt?: 'set' | 'null'
	/** Absolute delta the row's usage columns must reflect vs. their pre-settle values. */
	usageDelta?: {
		input?: number
		output?: number
		cacheRead?: number
		cacheCreation?: number
		costUsd?: number
	}
	stoppedSandbox: StoppedSandboxOutcome
	pushedAgentFiles?: PushedAgentFilesOutcome
	/**
	 * Which `events.action` row the settle should have inserted, or `'none'`
	 * if the pre-condition was already-terminal (no new event fires).
	 */
	event?:
		| 'session_completed'
		| 'session_failed'
		| 'session_timeout'
		| 'session_stopped'
		| 'session_paused'
		| 'none'
	/**
	 * PostHog cell (§5.2 col 8). At commit 3's state, `settleSession` never emits
	 * (`posthogEmitted: false`); commit 4 wires the dual-emit. So passing
	 * `'emitted'` here is what a future test should assert once commit 4 lands.
	 * `'skipped'` is the current baseline for every cell.
	 */
	posthog?: 'emitted' | 'skipped'
}

/**
 * §5.4 assertion helper. Verifies the `SettleResult` and, where the caller
 * supplied `usageDelta`, the row's usage columns after the call.
 *
 * The `row` argument (post-settle sessions row) is optional so a caller that
 * only cares about the `SettleResult` shape (mocked-DB unit tests) can skip
 * the DB row check entirely. When present, it must be the row read AFTER the
 * settle call.
 */
export function expectSessionSettled(
	sessionId: string,
	settle: SettleResult,
	expected: ExpectedSessionSettled,
	row?: {
		status: string
		completedAt: Date | null
		inputTokens: number | null
		outputTokens: number | null
		cacheReadInputTokens: number | null
		cacheCreationInputTokens: number | null
		totalCostUsd: string | number | null
	} | null,
	priorUsage?: {
		input?: number
		output?: number
		cacheRead?: number
		cacheCreation?: number
		costUsd?: number
	},
): void {
	expect(settle.sessionId, 'settleSession returned sessionId mismatch').toBe(sessionId)
	expect(settle.finalStatus, 'finalStatus mismatch').toBe(expected.finalStatus)
	expect(settle.stoppedSandbox, 'stoppedSandbox cell').toBe(expected.stoppedSandbox)
	if (expected.pushedAgentFiles !== undefined) {
		expect(settle.pushedAgentFiles, 'pushedAgentFiles cell').toBe(expected.pushedAgentFiles)
	}
	if (expected.posthog !== undefined) {
		expect(settle.posthogEmitted, 'posthog cell').toBe(expected.posthog === 'emitted')
	}

	if (row) {
		expect(row.status, 'sessions.status').toBe(expected.finalStatus)
		if (expected.completedAt === 'set') {
			expect(row.completedAt, 'sessions.completed_at should be set').not.toBeNull()
		} else if (expected.completedAt === 'null') {
			expect(row.completedAt, 'sessions.completed_at should be null (pause)').toBeNull()
		}

		if (expected.usageDelta && priorUsage) {
			const prior = priorUsage
			const delta = expected.usageDelta
			if (delta.input !== undefined) {
				expect(row.inputTokens ?? 0, 'input tokens delta').toBe((prior.input ?? 0) + delta.input)
			}
			if (delta.output !== undefined) {
				expect(row.outputTokens ?? 0, 'output tokens delta').toBe(
					(prior.output ?? 0) + delta.output,
				)
			}
			if (delta.cacheRead !== undefined) {
				expect(row.cacheReadInputTokens ?? 0, 'cache read tokens delta').toBe(
					(prior.cacheRead ?? 0) + delta.cacheRead,
				)
			}
			if (delta.cacheCreation !== undefined) {
				expect(row.cacheCreationInputTokens ?? 0, 'cache creation tokens delta').toBe(
					(prior.cacheCreation ?? 0) + delta.cacheCreation,
				)
			}
			if (delta.costUsd !== undefined) {
				const raw = row.totalCostUsd
				const asNumber = typeof raw === 'string' ? Number(raw) : (raw ?? 0)
				expect(asNumber, 'total cost usd delta').toBeCloseTo(
					(prior.costUsd ?? 0) + delta.costUsd,
					6,
				)
			}
		}
	}
}

/**
 * §5.4 boot-staging assertion helper — asserts what a session's `<sessionDir>`
 * carries at boot time, or (post-boot) what the S3 push-agent-files RPC
 * uploaded to the session's prefix.
 *
 * The `boot` argument is the observed shape produced by the concurrent bet's
 * task 2 (workspace-skills staging, memory seeding, briefing-file dispatch).
 * This module ASSERTS on the shape; it does NOT write staging code.
 */
export interface ExpectedBootStaging {
	skills: 'staged' | 'empty'
	memory: 'staged' | 'empty'
	briefing: 'present' | 'absent'
}

export function expectBootStaging(
	sessionId: string,
	observed: {
		skills: { path: string; entries: string[] }
		memory: { path: string; entries: string[] }
		briefing: { path: string; exists: boolean }
	},
	expected: ExpectedBootStaging,
): void {
	if (expected.skills === 'staged') {
		expect(observed.skills.entries.length, `${sessionId}: /agent/skills entries`).toBeGreaterThan(0)
	} else {
		expect(observed.skills.entries.length, `${sessionId}: /agent/skills should be empty`).toBe(0)
	}
	if (expected.memory === 'staged') {
		expect(observed.memory.entries.length, `${sessionId}: /agent/memory entries`).toBeGreaterThan(0)
	} else {
		expect(observed.memory.entries.length, `${sessionId}: /agent/memory should be empty`).toBe(0)
	}
	if (expected.briefing === 'present') {
		expect(observed.briefing.exists, `${sessionId}: briefing file present`).toBe(true)
	} else {
		expect(observed.briefing.exists, `${sessionId}: briefing file absent`).toBe(false)
	}
}
