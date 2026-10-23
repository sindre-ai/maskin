import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classify } from '../classifier.js'
import { loadMaskinConfig } from '../lib/config.js'
import type { ClassifierInput, DiffFile } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const realRepoRoot = path.resolve(__dirname, '../../../..')

function file(overrides: Partial<DiffFile>): DiffFile {
	return {
		path: 'apps/dev/src/routes/items.ts',
		status: 'modified',
		additions: 3,
		deletions: 1,
		patch: '@@ -1,1 +1,1 @@\n-old\n+new',
		...overrides,
	}
}

// Runs the classifier the way CI does: with this repo's real .maskin files, not hand-built lists.
function classifyWithRealConfig(files: DiffFile[]) {
	const config = loadMaskinConfig(realRepoRoot)
	const input: ClassifierInput = {
		commit_sha: 'cafebabecafebabecafebabecafebabecafebabe',
		files,
		protected_paths: config.protected_paths,
		regex_floors: config.regex_floors,
		hot_tables: config.hot_tables,
		core_tables: config.core_tables,
	}
	return classify(input)
}

describe('classifier with the real .maskin config', () => {
	it('loads a non-empty protected-paths list', () => {
		expect(loadMaskinConfig(realRepoRoot).protected_paths).toContain('.github/workflows/**')
	})

	it('scores a CI-workflow-only diff 100 and requires human review', () => {
		const v = classifyWithRealConfig([
			file({ path: '.github/workflows/risk-score.yml' }),
			file({ path: '.github/workflows/ci.yml' }),
		])
		expect(v.score).toBe(100)
		expect(v.band).toBe('human_review_required')
		expect(v.floors_applied.map((f) => f.kind)).toEqual(['protected_path', 'protected_path'])
		expect(v.floors_applied[0]?.evidence).toContain('.github/workflows/risk-score.yml')
	})

	it('still lets an ordinary feature diff through', () => {
		const v = classifyWithRealConfig([file({ path: 'apps/dev/src/routes/items.ts' })])
		expect(v.band).toBe('auto')
		expect(v.floors_applied).toEqual([])
	})
})
