import type { Trajectory } from './agent'
import type { RoutingCase, TrajectoryCase } from './cases'
import type { Fixture } from './fixture'

/** What the model actually did on one attempt at one routing case. */
export interface Attempt {
	/** Name of the first tool the model called, or null when it called none. */
	calledTool: string | null
	/** Arguments of that call. Null when no tool was called. */
	input: Record<string, unknown> | null
}

export type Verdict =
	| 'pass'
	/** Called a tool, but the wrong one. */
	| 'wrong_tool'
	/** Right tool, arguments the handler could not act on. */
	| 'bad_args'
	/** A tool was required and none was called. */
	| 'missing_call'
	/** No tool was required and one was called anyway. */
	| 'unexpected_call'
	/** Trajectory only: ran out of turns without settling. */
	| 'turn_limit'
	/** Trajectory only: the workspace does not hold what was asked for. */
	| 'bad_final_state'
	/** Trajectory only: the end state is wrong and the server rejected a call. */
	| 'tool_error'

export interface Result {
	verdict: Verdict
	/** Null on pass; otherwise the one sentence explaining the failure. */
	reason: string | null
}

const PASS: Result = { verdict: 'pass', reason: null }

/**
 * Grade one routing attempt. Deterministic on purpose: no LLM judge, no
 * similarity threshold, nothing that drifts between runs. Every failure here is
 * a fact about the transcript, so a red bar is always actionable and a green
 * bar always means the same thing it meant last month.
 */
export function grade(testCase: RoutingCase, attempt: Attempt): Result {
	const { expectTool, expectArgs } = testCase
	const { calledTool, input } = attempt

	if (expectTool === null) {
		return calledTool === null
			? PASS
			: { verdict: 'unexpected_call', reason: `called ${calledTool}; no tool call was warranted` }
	}

	if (calledTool === null) {
		return { verdict: 'missing_call', reason: `answered without calling ${expectTool}` }
	}

	if (calledTool !== expectTool) {
		return { verdict: 'wrong_tool', reason: `called ${calledTool}, expected ${expectTool}` }
	}

	const argReason = expectArgs?.(input ?? {}) ?? null
	return argReason === null ? PASS : { verdict: 'bad_args', reason: argReason }
}

/**
 * Grade one trajectory attempt against the workspace it actually built.
 *
 * The end state is checked first, and a tool error is only ever reported when
 * the end state is also wrong. That ordering is deliberate: a model that calls
 * `create_loop` without the required `workspace_id`, reads the rejection, and
 * retries correctly has done the job. Failing it for the first call would grade
 * style rather than outcome, which is exactly what we said we would not do.
 * When the end state IS wrong, the first server rejection is a far more useful
 * sentence to read than "no loop object exists".
 */
export async function gradeTrajectory(
	testCase: TrajectoryCase,
	trajectory: Trajectory,
	fixture: Fixture,
): Promise<Result> {
	const reason = await testCase.expect(trajectory, fixture)
	if (reason === null) return PASS

	const failed = trajectory.calls.find((call) => call.isError)
	if (failed) {
		return {
			verdict: 'tool_error',
			reason: `${reason}; first rejected call was ${failed.name}: ${oneLine(failed.result)}`,
		}
	}

	// Checked after the assertion, not before: a model that hits the turn cap
	// having already built a correct loop passes, and one that hits it having
	// built nothing is better described by the cap than by the missing loop.
	if (trajectory.hitTurnLimit) {
		return {
			verdict: 'turn_limit',
			reason: `stopped at the ${trajectory.turns}-turn cap without finishing; ${reason}`,
		}
	}

	return { verdict: 'bad_final_state', reason }
}

/** Collapse a server error to something that fits on one report line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}
