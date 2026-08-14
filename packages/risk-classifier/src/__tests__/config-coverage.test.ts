import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classify } from '../classifier.js'
import { loadMaskinConfig } from '../lib/config.js'
import type { DiffFile } from '../types.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function diff(patchLine: string, file = 'apps/dev/src/analytics.ts'): DiffFile {
	return { path: file, status: 'modified', additions: 1, deletions: 0, patch: `@@\n+${patchLine}\n` }
}

function scoreFile(file: DiffFile) {
	const config = loadMaskinConfig(repoRoot)
	return classify({
		commit_sha: 'test',
		files: [file],
		protected_paths: config.protected_paths,
		regex_floors: config.regex_floors,
		hot_tables: config.hot_tables,
	})
}

describe('.maskin/ floor config — DoD coverage', () => {
	it.each([
		['apps/dev/src/routes/objects.ts', 'apps/dev/src/routes/**'],
		['apps/dev/src/services/session-manager.ts', 'apps/dev/src/services/session-manager.ts'],
		['packages/shared/src/templates/development-agents.ts', 'packages/shared/src/templates/development-agents.ts'],
		['apps/web/src/components/agents/mcp-servers.tsx', 'apps/web/src/components/agents/mcp-servers.tsx'],
		['packages/db/src/seed.ts', 'packages/db/src/seed.ts'],
		['scripts/one-off-backfill.sql', '**/*.sql'],
	])('protected-paths.yml — %s floors via %s', (filePath, expectedGlob) => {
		const verdict = scoreFile(diff('const x = 1', filePath))
		expect(verdict.score).toBe(100)
		expect(verdict.floors_applied.some((f) => f.kind === 'protected_path' && f.evidence.includes(expectedGlob))).toBe(true)
	})

	it.each([
		['PostHog', 'const t = "phx_abcdefghij0123456789zzzzz"'],
		['Google API key', 'const k = "AIzaSyD-1234567890abcdefghijklmnopqrstuvwx"'],
		['Coolify token shape', 'const c = "2|mUmdgABCDEFGHIJKLMNOPQRSTUV"'],
	])('risk-floors.yml — %s pattern triggers regex_floor_hit', (_label, line) => {
		const verdict = scoreFile(diff(line))
		expect(verdict.score).toBeGreaterThanOrEqual(60)
		expect(verdict.floors_applied.some((f) => f.kind === 'regex_floor_hit')).toBe(true)
	})
})
