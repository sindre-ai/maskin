import { describe, expect, it } from 'vitest'
import type { Trajectory } from '../agent'
import type { RoutingCase, TrajectoryCase } from '../cases'
import type { Fixture } from '../fixture'
import { grade, gradeTrajectory } from '../grade'

const needsSearch: RoutingCase = {
	kind: 'routing',
	id: 'x',
	intent: 'test',
	prompt: 'p',
	expectTool: 'search_objects',
	expectArgs: (input) => (input.q ? null : 'no query passed in `q`'),
}

const needsNoTool: RoutingCase = {
	kind: 'routing',
	id: 'y',
	intent: 'test',
	prompt: 'p',
	expectTool: null,
}

describe('grade', () => {
	it('passes when the expected tool is called with acceptable args', () => {
		expect(grade(needsSearch, { calledTool: 'search_objects', input: { q: 'billing' } })).toEqual({
			verdict: 'pass',
			reason: null,
		})
	})

	it('returns wrong_tool naming both tools when a different tool is called', () => {
		const result = grade(needsSearch, { calledTool: 'list_objects', input: {} })
		expect(result.verdict).toBe('wrong_tool')
		expect(result.reason).toContain('list_objects')
		expect(result.reason).toContain('search_objects')
	})

	it('returns bad_args with the checker reason when the right tool gets unusable args', () => {
		expect(grade(needsSearch, { calledTool: 'search_objects', input: {} })).toEqual({
			verdict: 'bad_args',
			reason: 'no query passed in `q`',
		})
	})

	it('returns missing_call when a required tool is not called', () => {
		expect(grade(needsSearch, { calledTool: null, input: null }).verdict).toBe('missing_call')
	})

	it('passes a no-tool case only when no tool was called', () => {
		expect(grade(needsNoTool, { calledTool: null, input: null }).verdict).toBe('pass')
		expect(grade(needsNoTool, { calledTool: 'list_objects', input: {} }).verdict).toBe(
			'unexpected_call',
		)
	})

	it('treats a missing arg checker as an args pass', () => {
		const noArgCheck: RoutingCase = { ...needsSearch, expectArgs: undefined }
		expect(grade(noArgCheck, { calledTool: 'search_objects', input: {} }).verdict).toBe('pass')
	})
})

// The fixture is only ever read by a case's own `expect`, and these cases use
// stub expectations, so nothing here touches a database or an API.
const fixture = {} as Fixture

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
	return {
		calls: [],
		turns: 3,
		hitTurnLimit: false,
		finalText: 'done',
		inputTokens: 10,
		outputTokens: 5,
		...over,
	}
}

function caseWith(expect_: TrajectoryCase['expect']): TrajectoryCase {
	return { kind: 'trajectory', id: 't', intent: 'test', prompt: 'p', maxTurns: 5, expect: expect_ }
}

describe('gradeTrajectory', () => {
	it('passes when the end-state assertion returns null', async () => {
		const result = await gradeTrajectory(
			caseWith(() => null),
			trajectory(),
			fixture,
		)
		expect(result).toEqual({ verdict: 'pass', reason: null })
	})

	it('returns bad_final_state carrying the assertion sentence verbatim', async () => {
		const result = await gradeTrajectory(
			caseWith(() => 'no loop object exists in the workspace'),
			trajectory(),
			fixture,
		)
		expect(result.verdict).toBe('bad_final_state')
		expect(result.reason).toBe('no loop object exists in the workspace')
	})

	it('passes despite a rejected call when the model recovered and the end state is right', async () => {
		// The behaviour under test is the ordering rule: outcome first. A model
		// that gets a rejection, reads it, and retries correctly has done the job.
		const recovered = trajectory({
			calls: [
				{ name: 'create_loop', input: {}, result: 'workspace_id is required', isError: true },
				{ name: 'create_loop', input: {}, result: 'created', isError: false },
			],
		})
		expect(
			(
				await gradeTrajectory(
					caseWith(() => null),
					recovered,
					fixture,
				)
			).verdict,
		).toBe('pass')
	})

	it('reports tool_error with the first rejection when the end state is also wrong', async () => {
		const failed = trajectory({
			calls: [
				{ name: 'create_loop', input: {}, result: 'workspace_id is\n  required', isError: true },
			],
		})
		const result = await gradeTrajectory(
			caseWith(() => 'no loop object exists'),
			failed,
			fixture,
		)
		expect(result.verdict).toBe('tool_error')
		expect(result.reason).toContain('create_loop')
		// Collapsed to one line so a report row stays readable.
		expect(result.reason).toContain('workspace_id is required')
	})

	it('reports turn_limit when the run never settled and built nothing', async () => {
		const stuck = trajectory({ hitTurnLimit: true, turns: 5 })
		const result = await gradeTrajectory(
			caseWith(() => 'no loop object exists'),
			stuck,
			fixture,
		)
		expect(result.verdict).toBe('turn_limit')
		expect(result.reason).toContain('5-turn cap')
	})

	it('passes a run that hit the turn cap after already building the right thing', async () => {
		const stuck = trajectory({ hitTurnLimit: true })
		expect(
			(
				await gradeTrajectory(
					caseWith(() => null),
					stuck,
					fixture,
				)
			).verdict,
		).toBe('pass')
	})
})
