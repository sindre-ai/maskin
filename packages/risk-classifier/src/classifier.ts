import { createHash } from 'node:crypto'
import { collectGates } from './gates.js'
import { isGeneratedFile } from './lib/generated.js'
import { collectSignals } from './signals.js'
import type { ClassifierInput, ClassifierVerdict, RiskBand, SignalHit } from './types.js'
import { SKILL_VERSION } from './types.js'

const AUTO_MAX_SCORE = 24

export function classify(rawInput: ClassifierInput): ClassifierVerdict {
	// Generated files (lock files, the OpenAPI snapshot and client, drizzle snapshots) are left out of
	// everything below: not counted, not gated.
	const files = rawInput.files.filter((f) => !isGeneratedFile(f.path))
	const input = { ...rawInput, files }

	// Signals are still collected so the PR comment stays informative, but they no
	// longer decide the outcome. Only the gates do: a critical path from
	// .maskin/protected-paths.yml, or a migration that trips a rule in gates.ts, is
	// human_review_required; everything else is auto. Regex floors are not consulted for the band.
	const { signals, floors_applied: signalFloors } = collectSignals(input)
	const floors_applied = [
		...signalFloors.filter((f) => f.kind === 'protected_path'),
		...collectGates(input),
	]

	const sumWeights = signals.reduce((acc, s) => acc + s.weight, 0)
	const cappedAdditive = Math.min(sumWeights, 100)

	// Keep the displayed score consistent with the band.
	const score = floors_applied.length > 0 ? 100 : Math.min(cappedAdditive, AUTO_MAX_SCORE)

	const band = bandForScore(score)
	const deterministic_seed = computeSeed(input, signals, floors_applied, score)

	return {
		skill_version: SKILL_VERSION,
		commit_sha: input.commit_sha,
		score,
		band,
		signals,
		floors_applied,
		total_lines_changed: files.reduce((acc, f) => acc + f.additions + f.deletions, 0),
		generated_files_ignored: rawInput.files.length - files.length,
		deterministic_seed,
	}
}

export function bandForScore(score: number): RiskBand {
	if (score >= 80) return 'human_review_required'
	if (score >= 25) return 'agent_recommends_human'
	return 'auto'
}

function computeSeed(
	input: ClassifierInput,
	signals: SignalHit[],
	floors: SignalHit[],
	score: number,
): string {
	const stable = JSON.stringify({
		commit_sha: input.commit_sha,
		score,
		signals: [...signals]
			.map((s) => ({ kind: s.kind, weight: s.weight }))
			.sort((a, b) => a.kind.localeCompare(b.kind)),
		floors: [...floors].map((s) => s.kind).sort(),
		skill_version: SKILL_VERSION,
	})
	return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}
