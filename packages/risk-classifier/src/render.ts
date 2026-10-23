import type { ClassifierVerdict, SignalHit } from './types.js'

const BAND_LABEL: Record<ClassifierVerdict['band'], string> = {
	auto: 'AUTO-APPROVE ELIGIBLE',
	agent_recommends_human: 'AGENT RECOMMENDS HUMAN',
	human_review_required: 'HUMAN REVIEW REQUIRED',
}

const MAX_GATES_SHOWN = 10

export function renderRiskScoreBlock(verdict: ClassifierVerdict): string {
	const lines: string[] = []
	lines.push('## Risk Score')
	lines.push('')
	lines.push(`**Score:** ${verdict.score}/100 — ${BAND_LABEL[verdict.band]}`)
	lines.push(`**Skill version:** ${verdict.skill_version}`)
	lines.push(`**Commit:** ${verdict.commit_sha}`)
	lines.push(`**Deterministic seed:** ${verdict.deterministic_seed}`)
	lines.push(`**Lines changed:** ${linesNote(verdict)}`)
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
	lines.push('### Gated by')
	if (verdict.floors_applied.length === 0) {
		lines.push('- (no gate triggered)')
	} else {
		for (const f of verdict.floors_applied) {
			lines.push(`- \`${f.kind}\` — ${f.evidence}`)
		}
	}
	lines.push('')
	return lines.join('\n')
}

function linesNote(verdict: ClassifierVerdict): string {
	const ignored =
		verdict.generated_files_ignored > 0
			? `, ${verdict.generated_files_ignored} generated file(s) not counted`
			: ''
	return `${verdict.total_lines_changed} (a note, not a gate${ignored})`
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
	const headline = `Risk ${verdict.score}/100 — ${BAND_LABEL[verdict.band]}`
	const gates = verdict.floors_applied.slice(0, MAX_GATES_SHOWN).map((f) => `- ${f.evidence}`)
	const hidden = verdict.floors_applied.length - gates.length
	if (hidden > 0) gates.push(`- ...and ${hidden} more`)
	const summary =
		gates.length > 0
			? `${headline}\n\nGated by:\n${gates.join('\n')}\n\nLines changed: ${linesNote(verdict)}`
			: `${headline}\n\nLines changed: ${linesNote(verdict)}`
	return { name: 'maskin/risk-score', conclusion, summary }
}
