import { describe, expect, it } from 'vitest'
import { classify } from '../classifier.js'
import { checkRunConclusion, renderRiskScoreBlock } from '../render.js'
import type { ClassifierInput } from '../types.js'

function trivialInput(): ClassifierInput {
	return {
		commit_sha: 'cafebabecafebabecafebabecafebabecafebabe',
		files: [
			{
				path: 'README.md',
				status: 'modified',
				additions: 1,
				deletions: 0,
				patch: '@@ -1,1 +1,1 @@\n+typo fix',
			},
		],
		protected_paths: [],
		regex_floors: [],
		hot_tables: [],
		kill_switch: false,
	}
}

describe('renderRiskScoreBlock', () => {
	it('emits a `## Risk Score` block with score and band', () => {
		const v = classify(trivialInput())
		const out = renderRiskScoreBlock(v)
		expect(out).toMatch(/^## Risk Score/)
		expect(out).toContain(`**Score:** ${v.score}/100`)
		expect(out).toContain('AUTO-APPROVE ELIGIBLE')
		expect(out).toContain('**Skill version:**')
	})

	it('check-run name is `maskin/risk-score`', () => {
		const v = classify(trivialInput())
		expect(checkRunConclusion(v).name).toBe('maskin/risk-score')
		expect(checkRunConclusion(v).conclusion).toBe('success')
	})
})
