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
		core_tables: ['objects'],
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

	it('names the rule that gated the PR in both outputs', () => {
		const v = classify({
			...trivialInput(),
			core_tables: ['events'],
			files: [
				{
					path: 'packages/db/drizzle/0108_x.sql',
					status: 'added',
					additions: 1,
					deletions: 0,
					patch: '@@ -0,0 +1,1 @@\n+UPDATE events SET data = data;',
				},
			],
		})
		const summary = checkRunConclusion(v).summary
		expect(checkRunConclusion(v).conclusion).toBe('failure')
		expect(summary).toContain('Gated by')
		expect(summary).toContain('core table events')
		expect(renderRiskScoreBlock(v)).toContain('core table events')
	})

	it('shows total lines as a note, not a gate', () => {
		const v = classify(trivialInput())
		expect(renderRiskScoreBlock(v)).toContain('**Lines changed:** 1 (a note, not a gate)')
		expect(checkRunConclusion(v).summary).toContain('Lines changed: 1 (a note, not a gate)')
	})

	it('check-run name is `maskin/risk-score`', () => {
		const v = classify(trivialInput())
		expect(checkRunConclusion(v).name).toBe('maskin/risk-score')
		expect(checkRunConclusion(v).conclusion).toBe('success')
	})
})
