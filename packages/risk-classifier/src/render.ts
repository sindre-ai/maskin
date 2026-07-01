import type { ClassifierVerdict, SignalHit } from './types.js'

const BAND_LABEL: Record<ClassifierVerdict['band'], string> = {
	auto: 'AUTO-APPROVE ELIGIBLE',
	agent_recommends_human: 'AGENT RECOMMENDS HUMAN',
	two_human_required: 'TWO-HUMAN REQUIRED',
}

export function renderRiskScoreBlock(verdict: ClassifierVerdict): string {
	const lines: string[] = []
	lines.push('## Risk Score')
	lines.push('')
	lines.push(`**Score:** ${verdict.score}/100 — ${BAND_LABEL[verdict.band]}`)
	lines.push(`**Skill version:** ${verdict.skill_version}`)
	lines.push(`**Commit:** ${verdict.commit_sha}`)
	lines.push(`**Deterministic seed:** ${verdict.deterministic_seed}`)
	lines.push('')
	lines.push('### Signals')
	if (verdict.signals.length === 0) {
		lines.push('- (no scoring signals matched)')
	} else {
		for (const s of sortByWeightDesc(verdict.signals)) {
			lines.push(`- \`${s.kind}\` +${s.weight} — ${s.evidence}`)
		}
	}
	lines.push('')
	lines.push('### Floors applied')
	if (verdict.floors_applied.length === 0) {
		lines.push('- (no floors triggered)')
	} else {
		for (const f of verdict.floors_applied) {
			lines.push(`- \`${f.kind}\` — ${f.evidence}`)
		}
	}
	lines.push('')
	return lines.join('\n')
}

function sortByWeightDesc(signals: SignalHit[]): SignalHit[] {
	return [...signals].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind))
}

export function checkRunConclusion(verdict: ClassifierVerdict): {
	name: string
	conclusion: 'success' | 'neutral' | 'failure'
	summary: string
} {
	const conclusion =
		verdict.band === 'auto'
			? 'success'
			: verdict.band === 'agent_recommends_human'
				? 'neutral'
				: 'failure'
	return {
		name: 'maskin/risk-score',
		conclusion,
		summary: `Risk ${verdict.score}/100 — ${BAND_LABEL[verdict.band]}`,
	}
}
