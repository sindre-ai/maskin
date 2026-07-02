import { spawnSync } from 'node:child_process'
import type { SemgrepAlert } from '../types.js'
import { assertGitRef } from './git.js'

/**
 * Run a Semgrep diff scan between two commits. Returns the parsed alerts.
 *
 * The classifier never throws when Semgrep is not installed — the signal is
 * scored as zero. This keeps the binary runnable in environments that lack
 * SAST tooling (e.g. local CI for prototypes), at the cost of an explicit
 * unscored signal that observers can detect by inspecting the verdict.
 */
export function runSemgrepDiff(baseSha: string, headSha: string, cwd: string): SemgrepAlert[] {
	assertGitRef(baseSha)
	assertGitRef(headSha)
	const versionCheck = spawnSync('semgrep', ['--version'])
	if (versionCheck.status !== 0) return []

	const result = spawnSync(
		'semgrep',
		[
			'scan',
			'--quiet',
			'--json',
			'--config=auto',
			'--baseline-commit',
			baseSha,
			'--branch',
			headSha,
		],
		{ cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
	)
	if (result.status !== 0 && result.status !== 1) return []

	let parsed: unknown
	try {
		parsed = JSON.parse(result.stdout)
	} catch {
		return []
	}
	if (typeof parsed !== 'object' || parsed === null) return []
	const results = (parsed as Record<string, unknown>).results
	if (!Array.isArray(results)) return []

	const alerts: SemgrepAlert[] = []
	for (const raw of results) {
		if (typeof raw !== 'object' || raw === null) continue
		const r = raw as Record<string, unknown>
		const extra = (r.extra as Record<string, unknown> | undefined) ?? {}
		const start = (r.start as Record<string, unknown> | undefined) ?? {}
		alerts.push({
			rule_id: typeof r.check_id === 'string' ? r.check_id : 'unknown',
			severity: normalizeSeverity(typeof extra.severity === 'string' ? extra.severity : ''),
			path: typeof r.path === 'string' ? r.path : '',
			line: typeof start.line === 'number' ? start.line : 0,
		})
	}
	return alerts
}

function normalizeSeverity(input: string): SemgrepAlert['severity'] {
	switch (input.toUpperCase()) {
		case 'CRITICAL':
			return 'CRITICAL'
		case 'ERROR':
		case 'HIGH':
			return 'ERROR'
		case 'WARNING':
		case 'MEDIUM':
			return 'WARNING'
		default:
			return 'INFO'
	}
}
