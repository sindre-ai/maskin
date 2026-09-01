import type { Verdict } from './grade'

export interface CaseReport {
	id: string
	intent: string
	kind: 'routing' | 'trajectory'
	expectedTool: string | null
	attempts: number
	passes: number
	/** passes / attempts. With --repeat 1 this is always 0 or 1. */
	passRatio: number
	/** One entry per failed attempt: the verdict and why. Empty when all passed. */
	failures: { verdict: Verdict; reason: string; calledTool: string | null }[]
}

export interface RunReport {
	suite: string
	model: string
	/** Unix seconds. Stamped by the runner, never inside a graded attempt. */
	startedAt: number
	durationSeconds: number
	repeat: number
	cases: CaseReport[]
	passRatio: number
	verdictCounts: Record<Verdict, number>
	tokens: { input: number; output: number }
}

/** One gauge sample. The single definition of what this suite measures. */
export interface Metric {
	name: string
	labels: Record<string, string>
	value: number
}

/**
 * The metric set, once.
 *
 * Both encodings below - Prometheus text exposition and remote_write protobuf -
 * are rendered from this list, so a metric can never exist in the file we write
 * to disk and be missing from the series we push, or carry different labels in
 * the two. Add a measurement here and both consumers get it.
 *
 * Label cardinality is bounded by design: `case` ranges over the fixed set in
 * cases.ts, so scraping or pushing this on a schedule cannot blow up a
 * time-series index the way a per-run id or a timestamp label would.
 */
export function metrics(report: RunReport): Metric[] {
	const base = { suite: report.suite, model: report.model }
	const out: Metric[] = []

	for (const c of report.cases) {
		out.push({
			name: 'maskin_eval_case_pass_ratio',
			labels: { ...base, case: c.id, kind: c.kind, expected_tool: c.expectedTool ?? 'none' },
			value: c.passRatio,
		})
	}

	out.push({
		name: 'maskin_eval_suite_pass_ratio',
		labels: base,
		value: report.passRatio,
	})

	for (const [verdict, count] of Object.entries(report.verdictCounts)) {
		out.push({
			name: 'maskin_eval_verdict_total',
			labels: { ...base, verdict },
			value: count,
		})
	}

	out.push({
		name: 'maskin_eval_tokens',
		labels: { ...base, kind: 'input' },
		value: report.tokens.input,
	})
	out.push({
		name: 'maskin_eval_tokens',
		labels: { ...base, kind: 'output' },
		value: report.tokens.output,
	})

	out.push({
		name: 'maskin_eval_run_duration_seconds',
		labels: base,
		value: report.durationSeconds,
	})

	// Lets a dashboard grey out a panel whose data stopped refreshing, rather
	// than showing a months-old pass rate as if it were current.
	out.push({
		name: 'maskin_eval_run_timestamp_seconds',
		labels: base,
		value: report.startedAt,
	})

	return out
}

const HELP: Record<string, string> = {
	maskin_eval_case_pass_ratio: 'Share of attempts that passed, per eval case.',
	maskin_eval_suite_pass_ratio: 'Share of all attempts in the suite that passed.',
	maskin_eval_verdict_total: 'Attempts by outcome, including passes.',
	maskin_eval_tokens: 'Tokens consumed by the run, by direction.',
	maskin_eval_run_duration_seconds: 'Wall-clock duration of the run.',
	maskin_eval_run_timestamp_seconds: 'Unix time the run started.',
}

/** Prometheus label values may not contain a backslash, newline, or quote. */
function esc(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labels(pairs: Record<string, string>): string {
	const body = Object.entries(pairs)
		.map(([k, v]) => `${k}="${esc(v)}"`)
		.join(',')
	return `{${body}}`
}

/**
 * Render the run as Prometheus text-exposition format.
 *
 * This is the whole Grafana integration, and the reason it is not a lock-in:
 * the file is a public format that Alloy, Prometheus, VictoriaMetrics, Mimir,
 * Datadog's OpenMetrics check, and a `cat` all read. Grafana is one consumer
 * of it, swappable without touching this file or any eval case.
 */
export function toPrometheus(report: RunReport): string {
	const lines: string[] = []
	let lastName: string | null = null

	for (const m of metrics(report)) {
		// HELP/TYPE are emitted once per metric name. metrics() groups samples of
		// the same name together, so tracking the previous name is enough.
		if (m.name !== lastName) {
			lines.push(`# HELP ${m.name} ${HELP[m.name] ?? ''}`)
			lines.push(`# TYPE ${m.name} gauge`)
			lastName = m.name
		}
		lines.push(`${m.name}${labels(m.labels)} ${m.value}`)
	}

	return `${lines.join('\n')}\n`
}

/** Human summary for a terminal or a CI log. */
export function toText(report: RunReport): string {
	const lines: string[] = []
	for (const c of report.cases) {
		const ok = c.passes === c.attempts
		const mark = ok ? 'PASS' : 'FAIL'
		const score = report.repeat > 1 ? ` (${c.passes}/${c.attempts})` : ''
		lines.push(`${mark} ${c.id}${score}  ${c.intent}`)
		for (const f of c.failures) lines.push(`       ${f.verdict}: ${f.reason}`)
	}
	const pct = (report.passRatio * 100).toFixed(1)
	lines.push('')
	lines.push(
		`${report.suite} on ${report.model}: ${pct}% of attempts passed ` +
			`(${report.tokens.input} in / ${report.tokens.output} out tokens, ` +
			`${report.durationSeconds.toFixed(1)}s)`,
	)
	return lines.join('\n')
}
