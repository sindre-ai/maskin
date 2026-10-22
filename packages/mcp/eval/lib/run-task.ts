import { readSettledTelemetry } from './telemetry'
import type {
	ResultRow,
	RunOutcome,
	Seeder,
	StagingState,
	TaskContext,
	TaskDef,
	TelemetrySummary,
} from './types'

export const TOKENS_SOURCE = 'Agent SDK result message (modelUsage, summed over models)'

export interface RunDeps {
	workspaceId: string
	state: StagingState
	seeder: Seeder
	/** Starts the agent. Everything model-specific lives behind this. */
	runAgent(input: { prompt: string; sessionId: string }): Promise<RunOutcome>
	readTelemetry(sessionId: string): Promise<TelemetrySummary>
	newSessionId(): string
	now(): Date
	/** Telemetry settle timing; tests pass 0 so they do not wait. */
	settle?: { intervalMs: number; maxWaitMs: number }
}

export async function runTask(task: TaskDef, runIndex: number, deps: RunDeps): Promise<ResultRow> {
	const sessionId = deps.newSessionId()
	const ctx: TaskContext = {
		sessionId,
		short: sessionId.slice(0, 8),
		workspaceId: deps.workspaceId,
		state: deps.state,
		seeder: deps.seeder,
	}
	const seed = await task.setup(ctx)
	const outcome = await deps.runAgent({ prompt: task.prompt(ctx, seed), sessionId })
	const telemetry = await readSettledTelemetry(() => deps.readTelemetry(sessionId), deps.settle)
	// A run that never finished still gets checked: a partial result is a fail
	// with a reason, not a missing row.
	const check = await task.check(ctx, seed, telemetry, {
		notFoundByTool: outcome.clientNotFoundByTool,
	})
	return {
		task_id: task.id,
		held_out: task.heldOut,
		run_index: runIndex,
		session_id: sessionId,
		workspace_id: deps.workspaceId,
		passed: check.passed,
		check_reason: check.reason,
		call_count: telemetry.callCount,
		tokens: outcome.tokens,
		tokens_source: TOKENS_SOURCE,
		cost_usd: outcome.costUsd,
		errors_total: telemetry.errorsTotal,
		errors_by_kind: telemetry.errorsByKind,
		error_rows_by_tool: telemetry.errorRowsByTool,
		client_tool_uses: outcome.clientToolUses,
		client_tool_errors: outcome.clientToolErrors,
		client_not_found_by_tool: outcome.clientNotFoundByTool,
		num_turns: outcome.numTurns,
		duration_ms: outcome.durationMs,
		run_date: deps.now().toISOString(),
		runner: outcome.runner,
		model: outcome.model,
		run_error: outcome.error,
	}
}
