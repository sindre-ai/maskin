import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type RunDeps, runTask } from './lib/run-task'
import { loadQuery, runAgentSdk } from './lib/runner'
import { createRestSeeder } from './lib/seed'
import { createSqlState, openReadOnlySql } from './lib/state'
import { summarise } from './lib/summary'
import { readTelemetry } from './lib/telemetry'
import type { ResultRow } from './lib/types'
import { TASKS } from './tasks'

// Usage: see README.md. One invocation is one "step" (for example baseline, or
// after-aliases): every selected task, --runs times each, one results file.

const here = dirname(fileURLToPath(import.meta.url))

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing environment variable ${name}. See README.md.`)
	return value
}

function gitInfo(repoRoot: string): { sha: string; branch: string } {
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
	return { sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') }
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			step: { type: 'string' },
			runs: { type: 'string', default: '3' },
			tasks: { type: 'string' },
			out: { type: 'string', default: join(here, 'results') },
		},
	})
	if (!values.step || !/^[a-z0-9-]+$/.test(values.step)) {
		throw new Error('--step is required: a label such as baseline or after-aliases (a-z, 0-9, -)')
	}
	const runs = Number(values.runs)
	if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a whole number')
	const wanted = values.tasks?.split(',')
	const tasks = wanted ? TASKS.filter((task) => wanted.includes(task.id)) : TASKS
	if (tasks.length === 0) throw new Error(`No task matches --tasks ${values.tasks}`)

	const apiUrl = requireEnv('MASKIN_EVAL_API_URL')
	const workspaceId = requireEnv('MASKIN_EVAL_WORKSPACE_ID')
	const apiKey = requireEnv('MASKIN_EVAL_API_KEY')
	const repoRoot = requireEnv('MASKIN_REPO_ROOT')
	const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY')
	const model = process.env.EVAL_MODEL ?? 'claude-sonnet-5-5'
	const maxTurns = Number(process.env.EVAL_MAX_TURNS ?? 30)
	const timeoutMs = Number(process.env.EVAL_RUN_TIMEOUT_MS ?? 300000)
	const maxCostUsd = Number(process.env.EVAL_MAX_COST_USD ?? 40)

	const seeder = createRestSeeder({ apiUrl, workspaceId, apiKey })
	const sql = openReadOnlySql(requireEnv('DATABASE_URL'), repoRoot)
	const state = createSqlState(sql, workspaceId)
	const query = await loadQuery()

	const systemPrompt = `You are an operations agent working in a Maskin workspace (workspace id ${workspaceId}). Use the Maskin tools to do what you are asked. Do the work yourself and do not ask questions. When you are done, reply with one short sentence.`

	const deps: RunDeps = {
		workspaceId,
		state,
		seeder,
		runAgent: ({ prompt, sessionId }) =>
			runAgentSdk(
				{
					prompt,
					systemPrompt,
					sessionId,
					apiUrl,
					workspaceId,
					apiKey,
					anthropicApiKey,
					model,
					maxTurns,
					timeoutMs,
				},
				query,
			),
		readTelemetry: (sessionId) => readTelemetry(sql, workspaceId, sessionId),
		newSessionId: randomUUID,
		now: () => new Date(),
	}

	const rows: ResultRow[] = []
	let spent = 0
	let stoppedEarly: string | null = null
	outer: for (let runIndex = 1; runIndex <= runs; runIndex++) {
		for (const task of tasks) {
			const row = await runTask(task, runIndex, deps)
			rows.push(row)
			spent += row.cost_usd ?? 0
			console.log(
				`${row.passed ? 'PASS' : 'FAIL'} ${task.id} run ${runIndex} calls=${row.call_count} errors=${row.errors_total} cost=${row.cost_usd?.toFixed(2) ?? 'n/a'} ${row.passed ? '' : row.check_reason}`,
			)
			if (spent > maxCostUsd) {
				stoppedEarly = `stopped after ${rows.length} runs: spent ${spent.toFixed(2)} USD, over EVAL_MAX_COST_USD ${maxCostUsd}`
				break outer
			}
		}
	}
	await sql.end()

	const git = gitInfo(repoRoot)
	const startedAt = rows[0]?.run_date ?? new Date().toISOString()
	const result = {
		step: values.step,
		started_at: startedAt,
		runner: 'agent-sdk',
		model,
		// What was measured: the checkout the staging stack was built from.
		stack_git_sha: git.sha,
		stack_git_branch: git.branch,
		staging_workspace_id: workspaceId,
		runs_per_task: runs,
		stopped_early: stoppedEarly,
		summary: summarise(rows),
		rows,
	}
	mkdirSync(values.out, { recursive: true })
	const file = join(
		values.out,
		`${values.step}-${startedAt.replace(/[:.]/g, '-')}-${git.sha.slice(0, 7)}.json`,
	)
	writeFileSync(file, `${JSON.stringify(result, null, '\t')}\n`)
	console.log(`\nResults written to ${file}`)
	console.log(JSON.stringify(result.summary, null, 2))
	if (stoppedEarly) console.log(stoppedEarly)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
