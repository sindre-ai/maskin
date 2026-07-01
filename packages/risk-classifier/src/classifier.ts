import { createHash } from 'node:crypto'
import { collectSignals } from './signals.js'
import type { ClassifierInput, ClassifierVerdict, RiskBand, SignalHit } from './types.js'
import { SKILL_VERSION } from './types.js'
import { PATH_FLOOR_SCORE, REGEX_FLOOR_SCORE } from './weights.js'

export function classify(input: ClassifierInput): ClassifierVerdict {
	const { signals, floors_applied } = collectSignals(input)

	const sumWeights = signals.reduce((acc, s) => acc + s.weight, 0)
	const cappedAdditive = Math.min(sumWeights, 100)

	const hasProtectedPath = floors_applied.some((s) => s.kind === 'protected_path')
	const hasRegexFloor = floors_applied.some((s) => s.kind === 'regex_floor_hit')

	let score: number
	if (hasProtectedPath) {
		score = PATH_FLOOR_SCORE
	} else if (hasRegexFloor) {
		score = Math.max(cappedAdditive, REGEX_FLOOR_SCORE)
	} else {
		score = cappedAdditive
	}

	const band = bandForScore(score)
	const deterministic_seed = computeSeed(input, signals, floors_applied, score)

	return {
		skill_version: SKILL_VERSION,
		commit_sha: input.commit_sha,
		score,
		band,
		signals,
		floors_applied,
		deterministic_seed,
	}
}

export function bandForScore(score: number): RiskBand {
	if (score >= 60) return 'two_human_required'
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
