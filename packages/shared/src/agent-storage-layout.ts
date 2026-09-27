// Shared contract between apps/dev (settleSession + parity tests) and
// apps/agent-server (POST /sessions/:id/stop and POST /sessions/:id/push-agent-files
// handlers). One source of truth so a schema drift on either side surfaces as a
// TypeScript error rather than a runtime shape mismatch.

/**
 * Directories under `/agent/` inside a session's guest that this bet's
 * `pushAgentFiles` uploads back to S3 at settle time. Skills and workspace are
 * deliberately excluded:
 *
 *   - `/agent/skills/` is read-only for the agent; its source of truth is the
 *     `workspaceSkills` table, staged on boot by the concurrent bet.
 *   - `/agent/workspace/` is covered by the existing session snapshot tarball
 *     (`session-workspaces/*.tar.gz`) and must not be double-pushed here.
 */
export const AGENT_PUSH_DIRECTORIES = ['learnings', 'memory'] as const

export type AgentPushDirectory = (typeof AGENT_PUSH_DIRECTORIES)[number]

/**
 * S3 prefix for a given push directory. Both this bet's `pushAgentFiles` (write
 * path) and the concurrent bet's boot-side memory staging (read path) derive
 * the key from this helper — a rename on one side is a compile error on the
 * other.
 */
export function agentStorageS3Prefix(
	workspaceId: string,
	actorId: string,
	directory: AgentPushDirectory,
): string {
	return `s3://agents/${workspaceId}/${actorId}/${directory}/`
}

// ---------------------------------------------------------------------------
// Terminal-outcome primitives shared with settleSession()
// ---------------------------------------------------------------------------

/**
 * The five kinds of terminal outcome settleSession() writes. Mirrored in
 * `apps/dev/src/services/session-lifecycle.ts` and asserted by the guard test
 * (§4). Kept in shared so the stop RPC's request body can name the same union
 * without pulling `apps/dev` types into `apps/agent-server`.
 */
export type TerminalOutcomeKind = 'complete' | 'fail' | 'timeout' | 'stop' | 'pause'

/**
 * Who invoked settleSession(). Same rationale as `TerminalOutcomeKind`.
 */
export type SettleSource =
	| 'sandbox-exit'
	| 'reaper'
	| 'reconciler'
	| 'user-stop'
	| 'timeout-watchdog'
	| 'dispatch-queue'
	| 'idle-watcher'

// ---------------------------------------------------------------------------
// POST /sessions/:sessionId/stop  (§2.2)
// ---------------------------------------------------------------------------

/**
 * Request body for the remote-stop endpoint. The current handler at
 * `apps/agent-server/src/index.ts:1372` already seeds `FORCED_STOP_EXIT_CODE`
 * into `sessionExitCodes` before calling the runtime stop — that ordering is
 * load-bearing for `/complete`'s exit-code recovery and must survive the
 * body/response reshape in commit 2.
 */
export interface StopSessionRequest {
	reason: TerminalOutcomeKind
	source: SettleSource
}

export type StopSessionOutcome = 'sandbox-stopped' | 'sandbox-already-gone' | 'sandbox-not-found'

export interface StopSessionResponse {
	stopped: StopSessionOutcome
}

// ---------------------------------------------------------------------------
// POST /sessions/:sessionId/push-agent-files  (§7.1)
// ---------------------------------------------------------------------------

export interface PushAgentFilesRequest {
	directories: readonly AgentPushDirectory[]
}

export interface PushAgentFilesPushedEntry {
	files: number
	bytes: number
}

export interface PushAgentFilesError {
	dir: AgentPushDirectory | string
	message: string
}

export interface PushAgentFilesResponse {
	pushed: {
		[K in AgentPushDirectory]?: PushAgentFilesPushedEntry
	}
	errors: PushAgentFilesError[]
}
