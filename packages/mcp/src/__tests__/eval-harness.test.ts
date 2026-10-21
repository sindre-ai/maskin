import { describe, expect, it } from 'vitest'
import { runTask } from '../../eval/lib/run-task'
import { type SdkMessage, buildQueryOptions, runAgentSdk } from '../../eval/lib/runner'
import { H6_TASK_ID, summarise } from '../../eval/lib/summary'
import { readSettledTelemetry, summariseTelemetry } from '../../eval/lib/telemetry'
import type {
	EdgeRow,
	ObjectRow,
	ResultRow,
	RunOutcome,
	Seeder,
	SessionRow,
	StagingState,
	TelemetrySummary,
} from '../../eval/lib/types'
import { H6_SEED_CONTENT, H6_SKILL_NAME, TASKS, h6Marker } from '../../eval/tasks'

// The eval harness is a script, but its judgement is plain logic: telemetry
// counting, the per-task checkers and the pass-rate summary. None of that needs
// a model, so it is covered here. The agent runs themselves are not.

const sessionId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const short = sessionId.slice(0, 8)
const wsId = '00000000-0000-0000-0000-0000000000aa'

function noErrors(callCount = 0): TelemetrySummary {
	return summariseTelemetry([{ event_type: 'tool_call', tool_name: 'x', kind: null, n: callCount }])
}

function task(id: string) {
	const found = TASKS.find((candidate) => candidate.id === id)
	if (!found) throw new Error(`no task ${id}`)
	return found
}

function obj(overrides: Partial<ObjectRow> & Pick<ObjectRow, 'id' | 'type'>): ObjectRow {
	return { title: null, status: 'signal', content: null, driver: null, ...overrides }
}

class FakeState implements StagingState {
	objects: ObjectRow[] = []
	edges: EdgeRow[] = []
	skills = new Map<string, string>()
	sessions: SessionRow[] = []
	async objectsByTitle(title: string) {
		return this.objects.filter((row) => row.title === title)
	}
	async edgesInvolving(objectId: string) {
		return this.edges.filter((edge) => edge.sourceId === objectId || edge.targetId === objectId)
	}
	async skillContent(name: string) {
		return this.skills.get(name) ?? null
	}
	async sessionsInitiatedFrom(objectId: string) {
		return this.sessions.filter((row) => row.initiatedFromObjectId === objectId)
	}
}

function ctxFor(state: StagingState, seeder: Seeder) {
	return { sessionId, short, workspaceId: wsId, state, seeder }
}

class FakeSeeder implements Seeder {
	constructor(private state: FakeState) {}
	private n = 0
	async createObject(input: { type: string; title: string; content?: string; status?: string }) {
		const id = `obj-${++this.n}`
		this.state.objects.push(
			obj({ id, type: input.type, title: input.title, content: input.content ?? null }),
		)
		return { id }
	}
	async createEdge(input: { sourceId: string; targetId: string; type: string }) {
		this.state.edges.push(input)
	}
	async ensureHelperAgent() {
		return { id: 'helper-1' }
	}
	async putSkill(name: string, content: string) {
		// The server puts its own header block in front of stored skill content.
		this.state.skills.set(name, `---\nname: ${name}\ndescription: \n---\n\n${content}`)
	}
}

describe('summariseTelemetry', () => {
	it('counts calls from tool_call rows and errors by the server kinds', () => {
		const summary = summariseTelemetry([
			{ event_type: 'tool_call', tool_name: 'get_objects', kind: null, n: 3 },
			{ event_type: 'tool_call', tool_name: 'create_objects', kind: null, n: 2 },
			{ event_type: 'error', tool_name: 'update_objects', kind: 'schema_validation_error', n: 2 },
			{ event_type: 'error', tool_name: 'get_objects', kind: 'tool_not_found', n: 1 },
			{ event_type: 'error', tool_name: 'x', kind: 'unknown_param', n: 4 },
		])
		expect(summary.callCount).toBe(5)
		expect(summary.errorsTotal).toBe(7)
		expect(summary.errorsByKind).toEqual({
			tool_not_found: 1,
			unknown_param: 4,
			schema_validation_error: 2,
		})
		expect(summary.errorRowsByTool.update_objects).toBe(2)
	})

	it('keeps an error of an unknown kind in the total but not in a kind column', () => {
		const summary = summariseTelemetry([
			{ event_type: 'error', tool_name: 'x', kind: 'something_new', n: 1 },
		])
		expect(summary.errorsTotal).toBe(1)
		expect(Object.values(summary.errorsByKind).reduce((a, b) => a + b, 0)).toBe(0)
	})
})

describe('readSettledTelemetry', () => {
	it('returns once two reads in a row agree', async () => {
		const reads = [noErrors(1), noErrors(2), noErrors(3), noErrors(3), noErrors(9)]
		let i = 0
		const result = await readSettledTelemetry(async () => reads[i++] as TelemetrySummary, {
			intervalMs: 0,
			maxWaitMs: 1000,
		})
		expect(result.callCount).toBe(3)
		expect(i).toBe(4)
	})
})

describe('task set', () => {
	it('has at least five original tasks, two held out, and H6 as its own task', () => {
		const original = TASKS.filter((candidate) => candidate.id !== H6_TASK_ID)
		expect(original.length).toBeGreaterThanOrEqual(5)
		expect(original.filter((candidate) => candidate.heldOut).length).toBeGreaterThanOrEqual(2)
		expect(TASKS.some((candidate) => candidate.id === H6_TASK_ID)).toBe(true)
	})

	it('never names an argument in a prompt', async () => {
		const argumentNames = [
			'workspace_id',
			'actor_id',
			'driver_id',
			'source_id',
			'target_id',
			'object_id',
			'initiated_from_object_id',
			'action_prompt',
			'updates',
			'ids',
		]
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		for (const candidate of TASKS) {
			const seed = await candidate.setup(ctx)
			const prompt = candidate.prompt(ctx, seed)
			for (const name of argumentNames) {
				expect(prompt, `${candidate.id} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`))
			}
		}
	})
})

describe('T1 bet with tasks', () => {
	function solved() {
		const state = new FakeState()
		state.objects.push(obj({ id: 'b', type: 'bet', title: `Eval bet ${short}` }))
		for (const letter of ['A', 'B', 'C']) {
			state.objects.push(
				obj({ id: `t${letter}`, type: 'task', title: `Eval task ${short} ${letter}` }),
			)
			state.edges.push({ sourceId: 'b', targetId: `t${letter}`, type: 'breaks_into' })
		}
		return state
	}

	it('passes when the bet breaks into each task', async () => {
		const state = solved()
		const result = await task('T1-bet-with-tasks').check(
			ctxFor(state, new FakeSeeder(state)),
			{},
			noErrors(),
		)
		expect(result).toEqual({ passed: true, reason: 'ok' })
	})

	it('fails when an edge points the wrong way', async () => {
		const state = solved()
		state.edges[1] = { sourceId: 'tB', targetId: 'b', type: 'breaks_into' }
		const result = await task('T1-bet-with-tasks').check(
			ctxFor(state, new FakeSeeder(state)),
			{},
			noErrors(),
		)
		expect(result.passed).toBe(false)
		expect(result.reason).toContain('task B')
	})

	it('fails when nothing was created', async () => {
		const state = new FakeState()
		const result = await task('T1-bet-with-tasks').check(
			ctxFor(state, new FakeSeeder(state)),
			{},
			noErrors(),
		)
		expect(result.passed).toBe(false)
	})
})

describe('T2 read by ids', () => {
	it('passes only when the note carries all three codes', async () => {
		const state = new FakeState()
		const seeder = new FakeSeeder(state)
		const ctx = ctxFor(state, seeder)
		const seed = await task('T2-read-by-ids').setup(ctx)
		const note = obj({ id: 'n', type: 'knowledge', title: `Eval codes ${short}` })
		state.objects.push(note)
		note.content = [seed.code1, seed.code2].join('\n')
		expect((await task('T2-read-by-ids').check(ctx, seed, noErrors())).passed).toBe(false)
		note.content = [seed.code1, seed.code2, seed.code3].join('\n')
		expect((await task('T2-read-by-ids').check(ctx, seed, noErrors())).passed).toBe(true)
	})
})

describe('T3 set driver', () => {
	it('passes only when the driver is the helper agent', async () => {
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		const seed = await task('T3-set-driver').setup(ctx)
		expect((await task('T3-set-driver').check(ctx, seed, noErrors())).passed).toBe(false)
		const row = state.objects.find((candidate) => candidate.id === seed.taskId) as ObjectRow
		row.driver = seed.helperId as string
		expect((await task('T3-set-driver').check(ctx, seed, noErrors())).passed).toBe(true)
	})
})

describe('T4 list links', () => {
	it('needs every linked title, whichever direction, and no decoy', async () => {
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		const seed = await task('T4-list-links').setup(ctx)
		const note = obj({ id: 'n', type: 'knowledge', title: `Eval links ${short}` })
		state.objects.push(note)
		const a = `Eval link ${short} A`
		const b = `Eval link ${short} B`
		const c = `Eval link ${short} C`
		note.content = [a, b].join('\n')
		expect((await task('T4-list-links').check(ctx, seed, noErrors())).passed).toBe(false)
		note.content = [a, b, c, `Eval decoy ${short} 1`].join('\n')
		expect((await task('T4-list-links').check(ctx, seed, noErrors())).passed).toBe(false)
		note.content = [a, b, c].join('\n')
		expect((await task('T4-list-links').check(ctx, seed, noErrors())).passed).toBe(true)
	})
})

describe('T5 start session', () => {
	it('passes when a session for the helper carries the instruction text', async () => {
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		const seed = await task('T5-start-session').setup(ctx)
		expect((await task('T5-start-session').check(ctx, seed, noErrors())).passed).toBe(false)
		state.sessions.push({
			id: 's1',
			actorId: seed.helperId as string,
			initiatedFromObjectId: seed.taskId as string,
			actionPrompt: `eval-handoff-${short}, please look at this task.`,
		})
		expect((await task('T5-start-session').check(ctx, seed, noErrors())).passed).toBe(true)
	})
})

describe('H6 skill lookup', () => {
	const h6 = task(H6_TASK_ID)

	async function seeded() {
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		const seed = await h6.setup(ctx)
		return { state, ctx, seed }
	}

	it('resets the skill in setup and takes the stored content as the old content', async () => {
		const state = new FakeState()
		const ctx = ctxFor(state, new FakeSeeder(state))
		state.skills.set(H6_SKILL_NAME, 'edited by an earlier run')
		const seed = await h6.setup(ctx)
		expect(seed.baseline).toBe(state.skills.get(H6_SKILL_NAME))
		expect(seed.baseline).toContain(H6_SEED_CONTENT)
		expect(seed.baseline).not.toContain('edited by an earlier run')
	})

	it('passes with the marker line appended and no error rows on the skill tools', async () => {
		const { state, ctx, seed } = await seeded()
		state.skills.set(H6_SKILL_NAME, `${seed.baseline}\n${h6Marker(ctx)}`)
		expect((await h6.check(ctx, seed, noErrors(4))).passed).toBe(true)
	})

	it('fails when the stored content is anything but old content plus marker', async () => {
		const { state, ctx, seed } = await seeded()
		expect((await h6.check(ctx, seed, noErrors())).passed).toBe(false)
		state.skills.set(H6_SKILL_NAME, `${h6Marker(ctx)}\n${seed.baseline}`)
		expect((await h6.check(ctx, seed, noErrors())).passed).toBe(false)
	})

	it('fails on an error row for get_workspace_skill even when the content is right', async () => {
		const { state, ctx, seed } = await seeded()
		state.skills.set(H6_SKILL_NAME, `${seed.baseline}\n${h6Marker(ctx)}`)
		const telemetry = summariseTelemetry([
			{
				event_type: 'error',
				tool_name: 'get_workspace_skill',
				kind: 'schema_validation_error',
				n: 1,
			},
		])
		const result = await h6.check(ctx, seed, telemetry)
		expect(result.passed).toBe(false)
		expect(result.reason).toContain('get_workspace_skill 1')
	})
})

describe('runTask', () => {
	it('writes one row with the runner, counts from telemetry and the check result', async () => {
		const state = new FakeState()
		const seeder = new FakeSeeder(state)
		const outcome: RunOutcome = {
			runner: 'agent-sdk',
			model: 'claude-test',
			costUsd: 0.12,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 },
			numTurns: 3,
			clientToolUses: 4,
			clientToolErrors: 1,
			finished: true,
			error: null,
			durationMs: 1234,
		}
		const row = await runTask(task(H6_TASK_ID), 2, {
			workspaceId: wsId,
			state,
			seeder,
			runAgent: async ({ sessionId: id }) => {
				state.skills.set(H6_SKILL_NAME, `${state.skills.get(H6_SKILL_NAME)}\neval-marker-${id}`)
				return outcome
			},
			readTelemetry: async () => noErrors(4),
			newSessionId: () => sessionId,
			now: () => new Date('2026-10-21T12:00:00.000Z'),
			settle: { intervalMs: 0, maxWaitMs: 0 },
		})
		expect(row).toMatchObject({
			task_id: H6_TASK_ID,
			run_index: 2,
			session_id: sessionId,
			workspace_id: wsId,
			passed: true,
			call_count: 4,
			cost_usd: 0.12,
			runner: 'agent-sdk',
			run_date: '2026-10-21T12:00:00.000Z',
			errors_total: 0,
		})
		expect(row.tokens?.total).toBe(15)
	})
})

describe('summarise', () => {
	function row(partial: Partial<ResultRow> & Pick<ResultRow, 'task_id' | 'passed'>): ResultRow {
		return {
			held_out: false,
			run_index: 1,
			session_id: 's',
			workspace_id: wsId,
			check_reason: '',
			call_count: 10,
			tokens: null,
			tokens_source: '',
			cost_usd: 0.5,
			errors_total: 0,
			errors_by_kind: { tool_not_found: 0, unknown_param: 0, schema_validation_error: 0 },
			error_rows_by_tool: {},
			client_tool_uses: 0,
			client_tool_errors: 0,
			num_turns: null,
			duration_ms: 0,
			run_date: '',
			runner: 'agent-sdk',
			model: null,
			run_error: null,
			...partial,
		}
	}

	it('keeps H6 out of the original pass rate and reports it on its own line', () => {
		const summary = summarise([
			row({ task_id: 'T1', passed: true, call_count: 8 }),
			row({ task_id: 'T1', passed: true, call_count: 12 }),
			row({ task_id: 'T2', passed: false }),
			row({ task_id: 'T3', passed: false, held_out: true }),
			row({ task_id: H6_TASK_ID, passed: false }),
			row({ task_id: H6_TASK_ID, passed: false }),
			row({ task_id: H6_TASK_ID, passed: false }),
		])
		expect(summary.original.runs).toBe(4)
		expect(summary.original.passRate).toBe(0.5)
		expect(summary.original.callsPerPassingTask).toBe(10)
		expect(summary.heldOut.runs).toBe(1)
		expect(summary.h6).toMatchObject({ runs: 3, passed: 0, allRunsPassed: false })
		expect(summary.cost.totalUsd).toBeCloseTo(3.5)
	})

	it('counts H6 as passed only when all three runs pass', () => {
		const rows = [1, 2, 3].map((n) => row({ task_id: H6_TASK_ID, passed: n !== 3 }))
		expect(summarise(rows).h6.allRunsPassed).toBe(false)
		expect(
			summarise([1, 2, 3].map(() => row({ task_id: H6_TASK_ID, passed: true }))).h6.allRunsPassed,
		).toBe(true)
		expect(summarise([row({ task_id: H6_TASK_ID, passed: true })]).h6.allRunsPassed).toBe(false)
	})
})

describe('runAgentSdk', () => {
	const input = {
		prompt: 'do it',
		systemPrompt: 'be brief',
		sessionId,
		apiUrl: 'http://localhost:3000',
		workspaceId: wsId,
		apiKey: 'ank_harness',
		anthropicApiKey: 'sk-test',
		model: 'claude-test',
		maxTurns: 5,
		timeoutMs: 1000,
	}

	it('attaches the Maskin MCP over HTTP with the harness key and the run uuid', () => {
		const options = buildQueryOptions(input, new AbortController())
		expect(options.mcpServers.maskin).toEqual({
			type: 'http',
			url: 'http://localhost:3000/mcp',
			headers: {
				Authorization: 'Bearer ank_harness',
				'X-Workspace-Id': wsId,
				'X-Maskin-Session-Id': sessionId,
			},
		})
		expect(options.tools).toEqual([])
		expect(options.env.ANTHROPIC_API_KEY).toBe('sk-test')
	})

	it('reads cost, tokens and client-side tool counts from the message stream', async () => {
		const messages: SdkMessage[] = [
			{
				type: 'assistant',
				message: { content: [{ type: 'text' }, { type: 'tool_use' }, { type: 'tool_use' }] },
			},
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', is_error: true }, { type: 'tool_result' }] },
			},
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				num_turns: 3,
				total_cost_usd: 0.4,
				modelUsage: {
					'claude-test': {
						inputTokens: 100,
						outputTokens: 20,
						cacheReadInputTokens: 50,
						cacheCreationInputTokens: 10,
						costUSD: 0.4,
					},
				},
			},
		]
		const outcome = await runAgentSdk(input, () =>
			(async function* () {
				yield* messages
			})(),
		)
		expect(outcome).toMatchObject({
			runner: 'agent-sdk',
			model: 'claude-test',
			costUsd: 0.4,
			numTurns: 3,
			clientToolUses: 2,
			clientToolErrors: 1,
			finished: true,
			error: null,
		})
		expect(outcome.tokens).toEqual({
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheCreation: 10,
			total: 180,
		})
	})

	it('reports a failed result instead of throwing', async () => {
		const outcome = await runAgentSdk(input, () =>
			(async function* () {
				yield {
					type: 'result',
					subtype: 'error_max_turns',
					is_error: true,
					errors: [],
				} satisfies SdkMessage
			})(),
		)
		expect(outcome.finished).toBe(false)
		expect(outcome.error).toBe('error_max_turns')
		expect(outcome.model).toBe('claude-test')
	})
})
