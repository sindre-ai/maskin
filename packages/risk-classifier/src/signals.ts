import { globMatch } from './lib/match.js'
import type { ClassifierInput, DiffFile, RegexFloor, SignalHit } from './types.js'
import {
	DDL_PATTERNS,
	PATH_PATTERNS,
	SECRETS_LIKE_PATTERNS,
	SIGNAL_WEIGHTS,
	diffLocBucketWeight,
	filesChangedBucketWeight,
	semgrepSeverityWeight,
} from './weights.js'

interface CollectedSignals {
	signals: SignalHit[]
	floors_applied: SignalHit[]
}

export function collectSignals(input: ClassifierInput): CollectedSignals {
	const signals: SignalHit[] = []
	const floors_applied: SignalHit[] = []

	const totalLoc = input.files.reduce((acc, f) => acc + f.additions + f.deletions, 0)
	const locWeight = diffLocBucketWeight(totalLoc)
	if (locWeight > 0) {
		signals.push({
			kind: 'diff_loc',
			weight: locWeight,
			evidence: `${totalLoc} lines changed across ${input.files.length} files`,
		})
	}

	const filesWeight = filesChangedBucketWeight(input.files.length)
	if (filesWeight > 0) {
		signals.push({
			kind: 'files_changed',
			weight: filesWeight,
			evidence: `${input.files.length} files changed`,
		})
	}

	for (const file of input.files) {
		for (const protectedPattern of input.protected_paths) {
			if (globMatch(protectedPattern, file.path)) {
				floors_applied.push({
					kind: 'protected_path',
					weight: 0,
					evidence: `${file.path} matches protected path "${protectedPattern}"`,
				})
				break
			}
		}
	}

	const pathHits = new Map<SignalHit['kind'], string[]>()
	for (const file of input.files) {
		for (const { kind, patterns } of PATH_PATTERNS) {
			if (patterns.some((p) => p.test(file.path))) {
				const arr = pathHits.get(kind) ?? []
				arr.push(file.path)
				pathHits.set(kind, arr)
			}
		}
	}
	for (const [kind, paths] of pathHits) {
		const weight = SIGNAL_WEIGHTS[kind as keyof typeof SIGNAL_WEIGHTS] ?? 0
		if (weight > 0) {
			signals.push({
				kind,
				weight,
				evidence: `${paths.length} file(s): ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '…' : ''}`,
			})
		}
	}

	const ddlFiles = input.files.filter(
		(f) =>
			(f.path.endsWith('.sql') || /(^|\/)schema\.prisma$/i.test(f.path)) &&
			DDL_PATTERNS.some((re) => re.test(f.patch)),
	)
	if (ddlFiles.length > 0 && !pathHits.has('paths_migrations_ddl')) {
		signals.push({
			kind: 'paths_migrations_ddl',
			weight: SIGNAL_WEIGHTS.paths_migrations_ddl,
			evidence: `DDL detected in: ${ddlFiles.map((f) => f.path).join(', ')}`,
		})
	}

	if (input.squawk_findings && input.squawk_findings.length > 0) {
		const blockingLockHits = input.squawk_findings.filter(
			(f) => f.severity === 'error' || f.hot_table_hit,
		)
		if (blockingLockHits.length > 0) {
			signals.push({
				kind: 'squawk_blocking_lock',
				weight: SIGNAL_WEIGHTS.squawk_blocking_lock,
				evidence: `squawk: ${blockingLockHits.length} blocking-lock finding(s) (rules: ${blockingLockHits.map((h) => h.rule).join(', ')})`,
			})
			if (blockingLockHits.some((h) => h.hot_table_hit)) {
				floors_applied.push({
					kind: 'regex_floor_hit',
					weight: 0,
					evidence: 'squawk hot-table DDL → floor 60 (per .maskin/hot-tables.yml)',
				})
			}
		}
	}

	if (input.public_api_surface_delta && input.public_api_surface_delta > 0) {
		signals.push({
			kind: 'public_api_surface_delta',
			weight: SIGNAL_WEIGHTS.public_api_surface_delta,
			evidence: `${input.public_api_surface_delta} public API symbol(s) added/removed`,
		})
	}

	if (input.new_deps_with_cve && input.new_deps_with_cve.length > 0) {
		signals.push({
			kind: 'new_deps_with_cve',
			weight: SIGNAL_WEIGHTS.new_deps_with_cve,
			evidence: `Deps with known CVE: ${input.new_deps_with_cve.join(', ')}`,
		})
	}

	const secretsHits = scanSecretsLike(input.files)
	if (secretsHits.length > 0) {
		signals.push({
			kind: 'secrets_like_patterns',
			weight: SIGNAL_WEIGHTS.secrets_like_patterns,
			evidence: `Secrets-like patterns in: ${secretsHits.slice(0, 3).join(', ')}${secretsHits.length > 3 ? '…' : ''}`,
		})
	}

	if (input.missing_tests_for_logic) {
		signals.push({
			kind: 'missing_tests_for_logic',
			weight: SIGNAL_WEIGHTS.missing_tests_for_logic,
			evidence: 'Logic changes without corresponding test changes',
		})
	}

	if (input.incident_density) {
		const hot = Object.entries(input.incident_density).filter(([, score]) => score >= 0.9)
		if (hot.length > 0) {
			const matchingFiles = input.files.filter((f) => hot.some(([path]) => path === f.path))
			if (matchingFiles.length > 0) {
				signals.push({
					kind: 'top_decile_incident_file',
					weight: SIGNAL_WEIGHTS.top_decile_incident_file,
					evidence: `Top-decile incident files touched: ${matchingFiles.map((f) => f.path).join(', ')}`,
				})
			}
		}
	}

	if (input.file_age_days) {
		const stale = input.files.filter((f) => (input.file_age_days?.[f.path] ?? 0) > 365)
		if (stale.length > 0) {
			signals.push({
				kind: 'file_unchanged_365d',
				weight: SIGNAL_WEIGHTS.file_unchanged_365d,
				evidence: `Files unchanged >365d: ${stale.map((f) => f.path).join(', ')}`,
			})
		}
	}

	if (input.ai_generated_marker) {
		signals.push({
			kind: 'ai_generated_marker',
			weight: SIGNAL_WEIGHTS.ai_generated_marker,
			evidence: 'PR carries AI-generated marker (Co-Authored-By or similar)',
		})
	}

	if (input.semgrep_alerts && input.semgrep_alerts.length > 0) {
		const totalSemgrepWeight = input.semgrep_alerts.reduce(
			(acc, a) => acc + semgrepSeverityWeight(a.severity),
			0,
		)
		if (totalSemgrepWeight > 0) {
			signals.push({
				kind: 'codeql_or_semgrep_alert',
				weight: totalSemgrepWeight,
				evidence: `${input.semgrep_alerts.length} SAST alert(s); severity-weighted +${totalSemgrepWeight}`,
			})
		}
	}

	const regexFloorHits = scanRegexFloors(input.files, input.regex_floors)
	for (const hit of regexFloorHits) floors_applied.push(hit)

	return { signals, floors_applied }
}

function scanSecretsLike(files: DiffFile[]): string[] {
	const hits: string[] = []
	for (const file of files) {
		const addedLines = file.patch
			.split('\n')
			.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
		const text = addedLines.join('\n')
		if (SECRETS_LIKE_PATTERNS.some((re) => re.test(text))) hits.push(file.path)
	}
	return hits
}

function scanRegexFloors(files: DiffFile[], floors: RegexFloor[]): SignalHit[] {
	const hits: SignalHit[] = []
	for (const file of files) {
		for (const floor of floors) {
			let re: RegExp
			try {
				re = new RegExp(floor.pattern, 'm')
			} catch {
				continue
			}
			for (const line of file.patch.split('\n')) {
				if (re.test(line)) {
					hits.push({
						kind: 'regex_floor_hit',
						weight: 0,
						evidence: `${file.path}: ${floor.description || floor.pattern}`,
					})
					break
				}
			}
		}
	}
	return hits
}
