// Evaluation harness for the deep_research tool (spec "deep_research tool, Shaping and tech
// spec", sections 5 and 12). Runs each question through POST /api/research, waits for the run,
// and writes one CSV row per run plus anonymised, shuffled reports for blind scoring.
//
// Run:
//   API_KEY=ank_... WORKSPACE_ID=... pnpm --filter @maskin/dev exec tsx scripts/research-eval.ts \
//     --questions questions.json --out eval-out [--limit 3] [--tag run1] [--budget-usd 65]
//
// Env: API_KEY and WORKSPACE_ID (required), API_BASE_URL (default http://localhost:3000).
// The workspace needs an Anthropic API key or custom endpoint saved, and the first run's
// cost_cents must match the search provider invoice line within 5% before any run counts.
//
// questions.json: [{ "question", "effort", "original_session_id", "context"?, "max_cost_usd"?,
//                    "baseline_report"? }]
//
// Output in --out:
//   results.csv    one row per run (cost, tokens, searches, extracts, wall-clock, researchers,
//                  tier 1 and 2 share, warnings, capped, over cap by more than 5%)
//   reports/R01.md blind reports, shuffled. Tool reports, plus baseline briefs if given
//   blind-key.json which blind id is which; keep it from the scorer
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
	type EvalQuestion,
	type RunRecord,
	assignBlindIds,
	buildCsv,
	checkMix,
	failedRun,
	normalizeRun,
	parseQuestions,
} from './research-eval-lib'

const POLL_MS = 5_000
// The run deadline is 20 minutes (spec 7.3); allow a little extra before giving up locally.
const GIVE_UP_MS = 25 * 60_000
const DONE_STATUSES = new Set(['done', 'capped', 'failed', 'interrupted'])
// These affect every run, so stop instead of recording the same error ten times.
const FATAL_HTTP = new Set([401, 402, 403])

const { values } = parseArgs({
	options: {
		questions: { type: 'string' },
		out: { type: 'string', default: 'eval-out' },
		limit: { type: 'string' },
		tag: { type: 'string', default: new Date().toISOString().slice(0, 10) },
		'budget-usd': { type: 'string', default: '65' },
		seed: { type: 'string', default: '1' },
	},
})

const apiKey = process.env.API_KEY
const workspaceId = process.env.WORKSPACE_ID
const baseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
if (!values.questions || !apiKey || !workspaceId) {
	console.error(
		'Usage: API_KEY=... WORKSPACE_ID=... research-eval.ts --questions <file.json> [--out dir]',
	)
	process.exit(1)
}

const headers = {
	Authorization: `Bearer ${apiKey}`,
	'X-Workspace-Id': workspaceId,
	'Content-Type': 'application/json',
}

class FatalError extends Error {}

async function startRun(q: EvalQuestion, key: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/research`, {
		method: 'POST',
		headers: { ...headers, 'Idempotency-Key': key },
		body: JSON.stringify({
			question: q.question,
			effort: q.effort,
			context: q.context,
			max_cost_usd: q.max_cost_usd,
		}),
	})
	const text = await res.text()
	if (res.status !== 202 && res.status !== 200) {
		const msg = `POST /api/research ${res.status}: ${text.slice(0, 300)}`
		throw FATAL_HTTP.has(res.status) ? new FatalError(msg) : new Error(msg)
	}
	const id = (JSON.parse(text) as { id?: unknown }).id
	if (typeof id !== 'string')
		throw new Error(`POST /api/research returned no id: ${text.slice(0, 300)}`)
	return id
}

async function waitForRun(id: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + GIVE_UP_MS
	while (Date.now() < deadline) {
		const res = await fetch(`${baseUrl}/api/research/${id}`, { headers })
		if (!res.ok)
			throw new Error(`GET /api/research/${id} ${res.status}: ${(await res.text()).slice(0, 300)}`)
		const body = (await res.json()) as Record<string, unknown>
		if (typeof body.status === 'string' && DONE_STATUSES.has(body.status)) return body
		await new Promise((r) => setTimeout(r, POLL_MS))
	}
	throw new Error(`run ${id} still not finished after ${GIVE_UP_MS / 60_000} minutes`)
}

async function main() {
	const all = parseQuestions(JSON.parse(readFileSync(resolve(values.questions as string), 'utf8')))
	const limit = values.limit ? Number(values.limit) : all.length
	const questions = all.slice(0, limit)
	if (!values.limit) {
		const problems = checkMix(all)
		if (problems.length > 0) {
			console.error(`Question set does not match the spec mix: ${problems.join('; ')}`)
			process.exit(1)
		}
	}
	const budgetCents = Number(values['budget-usd']) * 100
	const out = resolve(values.out as string)
	mkdirSync(join(out, 'reports'), { recursive: true })

	const runs: RunRecord[] = []
	let spentCents = 0
	for (const [i, q] of questions.entries()) {
		const index = i + 1
		if (spentCents >= budgetCents) {
			console.error(`Budget of $${values['budget-usd']} reached after ${i} runs; stopping.`)
			break
		}
		const t0 = Date.now()
		console.log(`[${index}/${questions.length}] ${q.effort}: ${q.question.slice(0, 80)}`)
		let id = ''
		try {
			id = await startRun(q, `eval-${values.tag}-${index}`)
			const raw = await waitForRun(id)
			runs.push(normalizeRun(q, index, id, raw, (Date.now() - t0) / 1000))
		} catch (err) {
			if (err instanceof FatalError) {
				console.error(err.message)
				break
			}
			runs.push(failedRun(q, index, id, 'error', String(err), (Date.now() - t0) / 1000))
		}
		const run = runs[runs.length - 1] as RunRecord
		spentCents += run.cost_cents ?? 0
		console.log(
			`  ${run.status} cost=${run.cost_cents ?? '?'}c cap=${run.cap_cents ?? '?'}c total=$${(spentCents / 100).toFixed(2)}`,
		)
		if (index === 1 && run.cost_cents !== null) {
			console.log(
				`  Eval-start gate: compare this run's ${run.cost_cents}c with the search provider invoice line (within 5%) before counting any run.`,
			)
		}
	}

	// Blind set: every run with a report, plus its baseline brief when a file was given.
	const items: { arm: 'tool' | 'baseline'; index: number }[] = []
	for (const r of runs) {
		if (r.report_md) items.push({ arm: 'tool', index: r.index })
		const file = questions[r.index - 1]?.baseline_report
		if (file) items.push({ arm: 'baseline', index: r.index })
	}
	const blind = assignBlindIds(items, Number(values.seed))
	for (const entry of blind) {
		const run = runs.find((r) => r.index === entry.index) as RunRecord
		const q = questions[entry.index - 1] as EvalQuestion
		const body =
			entry.arm === 'tool'
				? run.report_md
				: readFileSync(resolve(q.baseline_report as string), 'utf8')
		writeFileSync(join(out, 'reports', `${entry.blind_id}.md`), `# ${q.question}\n\n${body}\n`)
	}
	writeFileSync(join(out, 'blind-key.json'), `${JSON.stringify(blind, null, 2)}\n`)
	const toolBlindIds = new Map(
		blind.filter((b) => b.arm === 'tool').map((b) => [b.index, b.blind_id]),
	)
	writeFileSync(join(out, 'results.csv'), buildCsv(runs, toolBlindIds))

	const overCap = runs.filter((r) => r.over_cap_5pct).length
	const capped = runs.filter((r) => r.capped).length
	console.log(
		`Done: ${runs.length} runs, $${(spentCents / 100).toFixed(2)} spent, ${capped} capped, ${overCap} over cap by more than 5%. Output in ${out}`,
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
