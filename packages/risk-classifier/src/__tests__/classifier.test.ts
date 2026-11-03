import { describe, expect, it } from 'vitest'
import { classify } from '../classifier.js'
import { collectSignals } from '../signals.js'
import type { ClassifierInput, DiffFile, RegexFloor } from '../types.js'

function file(overrides: Partial<DiffFile> = {}): DiffFile {
	return {
		path: 'apps/dev/src/routes/items.ts',
		status: 'modified',
		additions: 10,
		deletions: 2,
		patch: '@@ -1,1 +1,1 @@\n-old\n+new',
		...overrides,
	}
}

function input(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
	return {
		commit_sha: 'cafebabecafebabecafebabecafebabecafebabe',
		files: [file()],
		protected_paths: [],
		regex_floors: [],
		hot_tables: [],
		...overrides,
	}
}

describe('classify', () => {
	it('returns auto-band for a tiny non-sensitive diff', () => {
		const v = classify(input())
		expect(v.band).toBe('auto')
		expect(v.score).toBeLessThan(25)
	})

	it('produces deterministic seed for identical input', () => {
		const a = classify(input())
		const b = classify(input())
		expect(a.deterministic_seed).toBe(b.deterministic_seed)
		expect(a.score).toBe(b.score)
	})

	it('does not block on a protected path alone', () => {
		const v = classify(
			input({
				files: [file({ path: 'packages/auth/src/index.ts' })],
				protected_paths: ['packages/auth/**'],
			}),
		)
		expect(v.band).toBe('auto')
		expect(v.floors_applied).toEqual([])
	})

	it('does not block on a regex floor hit alone', () => {
		const floors: RegexFloor[] = [{ pattern: '^-.*require_admin\\(', description: 'x' }]
		const v = classify(
			input({
				regex_floors: floors,
				files: [file({ patch: '@@ -1,1 +1,1 @@\n-  require_admin(req)\n+  // permissive' })],
			}),
		)
		expect(v.band).toBe('auto')
	})

	it('stays auto at exactly 1000 changed lines', () => {
		const v = classify(input({ files: [file({ additions: 600, deletions: 400 })] }))
		expect(v.band).toBe('auto')
	})

	it('requires human review above 1000 changed lines', () => {
		const v = classify(input({ files: [file({ additions: 600, deletions: 401 })] }))
		expect(v.band).toBe('human_review_required')
		expect(v.score).toBe(100)
		expect(v.floors_applied.some((f) => f.kind === 'loc_gate')).toBe(true)
	})

	it('stays auto with two code lines changed in a database file', () => {
		const v = classify(
			input({
				files: [
					file({
						path: 'packages/db/drizzle/0099_x.sql',
						patch:
							'@@ -1,1 +1,1 @@\n+-- a comment\n+\n+ALTER TABLE a ADD COLUMN b text;\n+CREATE INDEX i ON a(b);',
					}),
				],
			}),
		)
		expect(v.band).toBe('auto')
	})

	it('requires human review with more than two code lines changed in a database file', () => {
		const v = classify(
			input({
				files: [
					file({
						path: 'packages/db/src/schema.ts',
						patch:
							'@@ -1,1 +1,1 @@\n+// note\n+export const a = 1\n+export const b = 2\n-export const c = 3',
					}),
				],
			}),
		)
		expect(v.band).toBe('human_review_required')
		expect(v.floors_applied.some((f) => f.kind === 'db_change_gate')).toBe(true)
	})

	it('keeps the additive score below the auto ceiling when no gate fires', () => {
		const v = classify(
			input({
				files: [file({ path: '.github/workflows/ci.yml', additions: 400, deletions: 0 })],
				new_deps_with_cve: ['lodash@4.17.20'],
			}),
		)
		expect(v.band).toBe('auto')
		expect(v.score).toBeLessThan(25)
	})

	it('detects DDL in .sql files even when path-based detection misses', () => {
		const v = classify(
			input({
				files: [
					file({
						path: 'queries/ad-hoc.sql',
						patch: '@@ -1,1 +1,1 @@\n+ALTER TABLE users ADD COLUMN nickname text;',
					}),
				],
			}),
		)
		expect(v.signals.some((s) => s.kind === 'paths_migrations_ddl')).toBe(true)
	})

	it('flags secret-like patterns in added lines', () => {
		const v = classify(
			input({
				files: [
					file({
						path: 'apps/web/src/config.ts',
						patch: '@@ -1,1 +1,1 @@\n+const k = "AKIAEXAMPLE12345EXAM"',
					}),
				],
			}),
		)
		expect(v.signals.some((s) => s.kind === 'secrets_like_patterns')).toBe(true)
	})

	it('detects auth/session paths and adds 15', () => {
		const v = classify(input({ files: [file({ path: 'packages/auth/src/session.ts' })] }))
		expect(v.signals.find((s) => s.kind === 'paths_auth_session')?.weight).toBe(15)
	})

	it('detects gha workflows and adds 20', () => {
		const v = classify(input({ files: [file({ path: '.github/workflows/ci.yml' })] }))
		expect(v.signals.find((s) => s.kind === 'paths_gha_workflows')?.weight).toBe(20)
	})

	it('semgrep alerts add severity-weighted score', () => {
		const v = classify(
			input({
				semgrep_alerts: [
					{ rule_id: 'r1', severity: 'ERROR', path: 'a.ts', line: 1 },
					{ rule_id: 'r2', severity: 'WARNING', path: 'b.ts', line: 1 },
				],
			}),
		)
		const sast = v.signals.find((s) => s.kind === 'codeql_or_semgrep_alert')
		expect(sast?.weight).toBe(28)
	})

	it('files unchanged >365 days adds 5', () => {
		const v = classify(
			input({
				files: [file({ path: 'packages/db/src/legacy.ts' })],
				file_age_days: { 'packages/db/src/legacy.ts': 800 },
			}),
		)
		expect(v.signals.some((s) => s.kind === 'file_unchanged_365d')).toBe(true)
	})

	it('top-decile incident files add 10', () => {
		const v = classify(
			input({
				files: [file({ path: 'apps/dev/src/routes/sessions.ts' })],
				incident_density: { 'apps/dev/src/routes/sessions.ts': 0.95 },
			}),
		)
		expect(v.signals.some((s) => s.kind === 'top_decile_incident_file')).toBe(true)
	})

	it('signals are sorted in renderable order via collectSignals (no internal mutation)', () => {
		const a = collectSignals(input())
		const b = collectSignals(input())
		expect(a).toEqual(b)
	})
})
