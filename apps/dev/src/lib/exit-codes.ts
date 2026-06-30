// Reserved agent-session exit codes the runtime classifies before reporting
// completion. Anything not in this set is treated as a generic non-zero failure
// (potentially eligible for trigger-driven retry); codes listed here are
// terminal verdicts that downstream recovery paths must NOT respawn from.

// Disk-full at the workspace mount — classified inside agent-run.sh when a
// post-exit write probe fails. Mirrors curl's CURLE_OUT_OF_MEMORY (28) only by
// number; semantics here are purely "no space left on device". Kept in sync
// with ENOSPC_EXIT_CODE in docker/agent-base/agent-run.sh.
export const ENOSPC_EXIT_CODE = 28

// Exit codes that must never trigger a recovery/continuation session.
export const NON_RECOVERABLE_EXIT_CODES: ReadonlySet<number> = new Set([ENOSPC_EXIT_CODE])

export function isRecoverableExitCode(exitCode: number | null | undefined): boolean {
	if (exitCode == null) return true
	return !NON_RECOVERABLE_EXIT_CODES.has(exitCode)
}
