import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
// Source import for the same reason tools.ts uses one: the eval must run the
// prompt as it is written right now, not as it was at the last dist build.
import { CHIEF_OF_STAFF_SYSTEM_PROMPT } from '../../../packages/shared/src/templates/default-workspace-agents'
import { type Trajectory, runAgent } from './agent'
import { apiBaseUrl, waitForApi } from './api'
import { CASES, type EvalCase, type RoutingCase, type TrajectoryCase } from './cases'
import { McpExecutor } from './executor'
import { closeFixtureDb, createFixture } from './fixture'
import { type Attempt, type Result, type Verdict, grade, gradeTrajectory } from './grade'
import { type CaseReport, type RunReport, toPrometheus, toText } from './report'
import { ALL_TOOLS, buildToolDefinitions } from './tools'

const SUITE = 'mcp-tools'

/**
 * The operator framing every graded routing turn runs under. Deliberately thin:
 * these evals measure whether the tool *descriptions* in
 * packages/mcp/src/tools.ts are doing their job. Coaching the model here
 * ("prefer search when you see a keyword") would move the signal into this file
 * and hide a description that has stopped earning its place.
 */
const ROUTING_SYSTEM_PROMPT =
	'You are an agent operating on a Maskin workspace through its MCP tools. ' +
	'Use a tool when the task calls for one, and answer directly when it does not.'

interface Options {
	model: string
	repeat: number
	trajectoryRepeat: number
	outDir: string
	minPassRatio: number
	only: string[]
	kinds: EvalCase['kind'][]
	concurrency: number
}

function parseArgs(argv: string[]): Options {
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`)
		return i === -1 ? undefined : argv[i + 1]
	}
	// Number() yields NaN on junk and NaN propagates silently, so every numeric
	// flag is validated rather than defaulted-by-accident.
	const num = (name: string, fallback: number): number => {
		const raw = flag(name)
		if (raw === undefined) return fallback
		const parsed = Number(raw)
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`--${name} expects a non-negative number, got ${JSON.stringify(raw)}`)
		}
		return parsed
	}
	const list = (name: string): string[] => {
		const raw = flag(name)
		return raw
			? raw
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: []
	}

	const kinds = list('kind')
	for (const kind of kinds) {
		if (kind !== 'routing' && kind !== 'trajectory') {
			throw new Error(`--kind expects "routing" or "trajectory", got ${JSON.stringify(kind)}`)
		}
	}

	// Routing attempts are one cheap turn each, so repeating them is how we stop
	// ordinary model nondeterminism from reading as a regression. Trajectory
	// attempts are a dozen turns against a live stack; they get their own,
	// smaller default rather than inheriting a number chosen for the cheap case.
	const repeat = Math.max(1, Math.floor(num('repeat', 3)))
	return {
		model: flag('model') ?? process.env.EVAL_MODEL ?? 'claude-opus-5',
		repeat,
		trajectoryRepeat: Math.max(1, Math.floor(num('trajectory-repeat', Math.min(repeat, 2)))),
		outDir: flag('out') ?? join(process.cwd(), 'results'),
		minPassRatio: num('min', 0.9),
		only: list('case'),
		kinds: (kinds.length ? kinds : ['routing', 'trajectory']) as EvalCase['kind'][],
		concurrency: Math.max(1, Math.floor(num('concurrency', 4))),
	}
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function pooled<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = next++
			if (i >= items.length) return
			const item = items[i]
			if (item === undefined) return
			results[i] = await worker(item)
		}
	})
	await Promise.all(runners)
	return results
}

interface Outcome {
	testCase: EvalCase
	result: Result
	/** The tool named in the report line. First call for either kind. */
	calledTool: string | null
	inputTokens: number
	outputTokens: number
}

async function runRoutingAttempt(
	client: Anthropic,
	model: string,
	tools: Anthropic.Tool[],
	testCase: RoutingCase,
): Promise<Outcome> {
	const response = await client.messages.create({
		model,
		max_tokens: 4096,
		// Tool selection is a routing decision, not a reasoning problem. Low
		// effort keeps a full sweep cheap enough to run on every PR; the
		// trajectory cases below opt up, because planning a multi-step build is
		// a different question.
		output_config: { effort: 'low' },
		system: ROUTING_SYSTEM_PROMPT,
		tools,
		tool_choice: { type: 'auto' },
		messages: [{ role: 'user', content: testCase.prompt }],
	})

	const call = response.content.find((block) => block.type === 'tool_use')
	const attempt: Attempt = {
		calledTool: call ? call.name : null,
		input: call ? (call.input as Record<string, unknown>) : null,
	}
	return {
		testCase,
		result: grade(testCase, attempt),
		calledTool: attempt.calledTool,
		inputTokens: response.usage.input_tokens,
		outputTokens: response.usage.output_tokens,
	}
}

async function runTrajectoryAttempt(
	client: Anthropic,
	model: string,
	tools: Anthropic.Tool[],
	testCase: TrajectoryCase,
): Promise<Outcome> {
	// A fresh actor and a genuinely empty workspace per attempt. See fixture.ts
	// for why this cannot go through POST /api/workspaces.
	const fixture = await createFixture(testCase.id)
	const executor = new McpExecutor(fixture.apiKey, fixture.workspaceId)
	let trajectory: Trajectory
	try {
		trajectory = await runAgent({
			client,
			model,
			// The real Chief of Staff runs under this exact prompt with the whole
			// Maskin MCP server attached, so the eval does too. Substituting a
			// tidier prompt would measure a agent that does not exist.
			systemPrompt: CHIEF_OF_STAFF_SYSTEM_PROMPT,
			tools,
			prompt: testCase.prompt,
			executor,
			maxTurns: testCase.maxTurns,
			effort: 'medium',
		})
	} finally {
		await executor.close()
	}

	return {
		testCase,
		result: await gradeTrajectory(testCase, trajectory, fixture),
		calledTool: trajectory.calls[0]?.name ?? null,
		inputTokens: trajectory.inputTokens,
		outputTokens: trajectory.outputTokens,
	}
}

function emptyReport(testCase: EvalCase): CaseReport {
	return {
		id: testCase.id,
		intent: testCase.intent,
		kind: testCase.kind,
		expectedTool: testCase.kind === 'routing' ? testCase.expectTool : null,
		attempts: 0,
		passes: 0,
		passRatio: 0,
		failures: [],
	}
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2))
	const cases = CASES.filter(
		(c) => opts.kinds.includes(c.kind) && (opts.only.length === 0 || opts.only.includes(c.id)),
	)
	if (cases.length === 0) {
		const filters = opts.only.length ? ` --case ${opts.only.join(',')}` : ''
		throw new Error(`no cases matched --kind ${opts.kinds.join(',')}${filters}`)
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		throw new Error('ANTHROPIC_API_KEY is not set; every eval attempt calls the real API.')
	}

	const hasTrajectory = cases.some((c) => c.kind === 'trajectory')
	if (hasTrajectory) {
		// Fail here, with the command to fix it, rather than a hundred lines
		// deeper inside an MCP transport error on the first tool call.
		console.log(`Waiting for the Maskin API at ${apiBaseUrl()} ...`)
		await waitForApi()
	}

	const client = new Anthropic()
	const routingTools = buildToolDefinitions()
	// Trajectory cases get the full surface because the agent they stand in for
	// does: Chief of Staff is wired to the whole Maskin MCP server, not a
	// curated subset, and picking the right tool out of six is a different
	// (easier) problem than picking it out of all of them.
	const trajectoryTools = hasTrajectory ? buildToolDefinitions(ALL_TOOLS) : []

	// One flat work list so the pool saturates across cases as well as repeats,
	// instead of stalling on the slowest case in each round.
	const work = cases.flatMap((testCase) =>
		Array.from(
			{ length: testCase.kind === 'trajectory' ? opts.trajectoryRepeat : opts.repeat },
			() => testCase,
		),
	)

	const startedAt = Math.floor(Date.now() / 1000)
	const startedMs = Date.now()
	let outcomes: Outcome[]
	try {
		outcomes = await pooled(work, opts.concurrency, async (testCase) =>
			testCase.kind === 'routing'
				? runRoutingAttempt(client, opts.model, routingTools, testCase)
				: runTrajectoryAttempt(client, opts.model, trajectoryTools, testCase),
		)
	} finally {
		await closeFixtureDb()
	}
	const durationSeconds = (Date.now() - startedMs) / 1000

	const verdictCounts: Record<Verdict, number> = {
		pass: 0,
		wrong_tool: 0,
		bad_args: 0,
		missing_call: 0,
		unexpected_call: 0,
		turn_limit: 0,
		bad_final_state: 0,
		tool_error: 0,
	}
	const tokens = { input: 0, output: 0 }
	const byCase = new Map<string, CaseReport>(cases.map((c) => [c.id, emptyReport(c)]))

	for (const outcome of outcomes) {
		verdictCounts[outcome.result.verdict]++
		tokens.input += outcome.inputTokens
		tokens.output += outcome.outputTokens
		// Present for every case id, because byCase was seeded from `cases`.
		const entry = byCase.get(outcome.testCase.id) as CaseReport
		entry.attempts++
		if (outcome.result.verdict === 'pass') entry.passes++
		else {
			entry.failures.push({
				verdict: outcome.result.verdict,
				reason: outcome.result.reason ?? 'unknown',
				calledTool: outcome.calledTool,
			})
		}
	}
	for (const entry of byCase.values()) {
		entry.passRatio = entry.attempts === 0 ? 0 : entry.passes / entry.attempts
	}

	const report: RunReport = {
		suite: SUITE,
		model: opts.model,
		startedAt,
		durationSeconds,
		repeat: opts.repeat,
		cases: [...byCase.values()],
		passRatio: outcomes.length === 0 ? 0 : verdictCounts.pass / outcomes.length,
		verdictCounts,
		tokens,
	}

	const jsonPath = join(opts.outDir, `${SUITE}.json`)
	const promPath = join(opts.outDir, `${SUITE}.prom`)
	// Written as a file as well as printed, so CI can drop it straight into the
	// job summary rather than re-deriving the formatting in shell.
	const textPath = join(opts.outDir, 'summary.txt')
	const summary = toText(report)
	await mkdir(dirname(jsonPath), { recursive: true })
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
	await writeFile(promPath, toPrometheus(report), 'utf8')
	await writeFile(textPath, `${summary}\n`, 'utf8')

	console.log(summary)
	console.log(`\nwrote ${jsonPath}\nwrote ${promPath}\nwrote ${textPath}`)

	if (report.passRatio < opts.minPassRatio) {
		console.error(
			`\npass ratio ${report.passRatio.toFixed(3)} is below the --min gate of ${opts.minPassRatio}`,
		)
		process.exitCode = 1
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
