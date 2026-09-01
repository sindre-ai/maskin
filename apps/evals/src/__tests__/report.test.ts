import { describe, expect, it } from 'vitest'
import { type RunReport, metrics, toPrometheus } from '../report'

const report: RunReport = {
	suite: 'mcp-tools',
	model: 'claude-opus-5',
	startedAt: 1_756_000_000,
	durationSeconds: 12.5,
	repeat: 2,
	cases: [
		{
			id: 'search-by-keyword',
			intent: 'i',
			kind: 'routing',
			expectedTool: 'search_objects',
			attempts: 2,
			passes: 1,
			passRatio: 0.5,
			failures: [
				{ verdict: 'wrong_tool', reason: 'called list_objects', calledTool: 'list_objects' },
			],
		},
		{
			id: 'no-tool-for-ack',
			intent: 'i',
			kind: 'routing',
			expectedTool: null,
			attempts: 2,
			passes: 2,
			passRatio: 1,
			failures: [],
		},
		{
			id: 'create-loop-end-to-end',
			intent: 'i',
			kind: 'trajectory',
			expectedTool: null,
			attempts: 2,
			passes: 1,
			passRatio: 0.5,
			failures: [
				{ verdict: 'bad_final_state', reason: 'no loop object', calledTool: 'list_loops' },
			],
		},
	],
	passRatio: 0.75,
	verdictCounts: {
		pass: 3,
		wrong_tool: 1,
		bad_args: 0,
		missing_call: 0,
		unexpected_call: 0,
		turn_limit: 0,
		bad_final_state: 1,
		tool_error: 0,
	},
	tokens: { input: 100, output: 20 },
}

describe('metrics', () => {
	it('groups every sample of one metric name together', () => {
		// toPrometheus emits HELP/TYPE on each name change, so a name appearing in
		// two separate runs of samples would emit duplicate header lines.
		const names = metrics(report).map((m) => m.name)
		const firstSeen = names.map((n) => names.indexOf(n))
		expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b))
	})

	it('carries the case kind, so routing and trajectory health can be read apart', () => {
		const kinds = metrics(report)
			.filter((m) => m.name === 'maskin_eval_case_pass_ratio')
			.map((m) => m.labels.kind)
		expect(kinds).toEqual(['routing', 'routing', 'trajectory'])
	})
})

describe('toPrometheus', () => {
	const text = toPrometheus(report)

	it('emits one case gauge per case, labelled with the expected tool', () => {
		expect(text).toContain(
			'maskin_eval_case_pass_ratio{suite="mcp-tools",model="claude-opus-5",case="search-by-keyword",kind="routing",expected_tool="search_objects"} 0.5',
		)
	})

	it('labels a no-tool case as expected_tool="none" rather than dropping the label', () => {
		expect(text).toContain('case="no-tool-for-ack",kind="routing",expected_tool="none"} 1')
	})

	it('emits the suite ratio, every verdict, tokens, and a run timestamp', () => {
		expect(text).toContain(
			'maskin_eval_suite_pass_ratio{suite="mcp-tools",model="claude-opus-5"} 0.75',
		)
		expect(text).toContain('verdict="wrong_tool"} 1')
		expect(text).toContain('verdict="bad_args"} 0')
		expect(text).toContain('verdict="bad_final_state"} 1')
		expect(text).toContain('kind="input"} 100')
		expect(text).toContain(
			'maskin_eval_run_timestamp_seconds{suite="mcp-tools",model="claude-opus-5"} 1756000000',
		)
	})

	it('pairs every metric with a HELP and TYPE line and ends with a newline', () => {
		const names = [...text.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1])
		expect(new Set(names).size).toBe(names.length)
		expect(text.match(/^# HELP/gm)?.length).toBe(names.length)
		expect(text.endsWith('\n')).toBe(true)
	})

	it('renders one line per sample metrics() produced', () => {
		const bodyLines = text.split('\n').filter((l) => l && !l.startsWith('#'))
		expect(bodyLines).toHaveLength(metrics(report).length)
	})
})
