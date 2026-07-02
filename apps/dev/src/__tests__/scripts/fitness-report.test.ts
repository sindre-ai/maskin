import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../../../..')
const AGGREGATOR = join(REPO_ROOT, 'scripts/fitness-report.mjs')

type Baseline = {
	cycles?: Array<{ path: string[] }>
	boundary_violations?: Array<{ rule: string; from: string; to: string }>
	cognitive_complexity?: Array<{ file: string; fn: string; score?: number }>
	oversized_files?: Array<{ file: string; loc?: number }>
}

type Signals = {
	depcruise?: { summary: { violations: unknown[] } }
	biome?: { diagnostics: unknown[] }
	filesize?: Array<{ file: string; loc: number }>
	baseline?: Baseline
}

type Report = {
	name: string
	conclusion: 'success' | 'failure'
	summary: string
	totals: Record<string, { new: number; baseline: number; total: number }>
}

function run(signals: Signals): Report {
	const dir = mkdtempSync(join(tmpdir(), 'fitness-report-'))
	const paths = {
		depcruise: join(dir, 'dc.json'),
		biome: join(dir, 'biome.json'),
		filesize: join(dir, 'filesize.json'),
		baseline: join(dir, 'baseline.json'),
		output: join(dir, 'report.json'),
	}
	writeFileSync(
		paths.depcruise,
		JSON.stringify(signals.depcruise ?? { summary: { violations: [] } }),
	)
	writeFileSync(paths.biome, JSON.stringify(signals.biome ?? { diagnostics: [] }))
	writeFileSync(paths.filesize, JSON.stringify(signals.filesize ?? []))
	if (signals.baseline) writeFileSync(paths.baseline, JSON.stringify(signals.baseline))

	execFileSync('node', [AGGREGATOR], {
		env: {
			...process.env,
			DEPCRUISE_JSON: paths.depcruise,
			BIOME_JSON: paths.biome,
			FILESIZE_JSON: paths.filesize,
			BASELINE_JSON: paths.baseline,
			OUTPUT_JSON: paths.output,
		},
		stdio: ['ignore', 'ignore', 'ignore'],
	})
	const report = JSON.parse(readFileSync(paths.output, 'utf8')) as Report
	rmSync(dir, { recursive: true, force: true })
	return report
}

describe('scripts/fitness-report.mjs', () => {
	it('reports success on a clean tree with no baseline', () => {
		const report = run({})
		expect(report.name).toBe('maskin/fitness')
		expect(report.conclusion).toBe('success')
		expect(report.totals.cycles.new).toBe(0)
		expect(report.totals.boundary_violations.new).toBe(0)
		expect(report.totals.cognitive_complexity.new).toBe(0)
		expect(report.totals.oversized_files.new).toBe(0)
	})

	it('flags a new cycle as a new violation when baseline is empty', () => {
		const report = run({
			depcruise: {
				summary: {
					violations: [
						{
							type: 'cycle',
							from: 'a.ts',
							to: 'b.ts',
							rule: { name: 'no-circular', severity: 'error' },
							cycle: [{ name: 'a.ts' }, { name: 'b.ts' }],
						},
					],
				},
			},
			baseline: {},
		})
		expect(report.conclusion).toBe('failure')
		expect(report.totals.cycles.new).toBe(1)
	})

	it('treats a cycle as accepted debt when it matches the baseline (rotation-invariant)', () => {
		const report = run({
			depcruise: {
				summary: {
					violations: [
						{
							rule: { name: 'no-circular' },
							cycle: [{ name: 'b.ts' }, { name: 'a.ts' }],
						},
					],
				},
			},
			baseline: {
				cycles: [{ path: ['a.ts', 'b.ts'] }],
			},
		})
		expect(report.conclusion).toBe('success')
		expect(report.totals.cycles.new).toBe(0)
		expect(report.totals.cycles.baseline).toBe(1)
		expect(report.totals.cycles.total).toBe(1)
	})

	it('deduplicates a cycle reported once per starting edge by dep-cruiser', () => {
		const report = run({
			depcruise: {
				summary: {
					violations: [
						{
							rule: { name: 'no-circular' },
							cycle: [{ name: 'a.ts' }, { name: 'b.ts' }],
						},
						{
							rule: { name: 'no-circular' },
							cycle: [{ name: 'b.ts' }, { name: 'a.ts' }],
						},
					],
				},
			},
		})
		expect(report.totals.cycles.total).toBe(1)
	})

	it('diffs boundary violations against the baseline by {rule, from, to}', () => {
		const report = run({
			depcruise: {
				summary: {
					violations: [
						{
							type: 'module',
							from: 'packages/shared/x.ts',
							to: 'packages/db/y.ts',
							rule: { name: 'shared-is-leaf', severity: 'error' },
						},
						{
							type: 'module',
							from: 'apps/web/a.ts',
							to: 'apps/dev/b.ts',
							rule: { name: 'web-no-server-apps', severity: 'error' },
						},
					],
				},
			},
			baseline: {
				boundary_violations: [
					{ rule: 'shared-is-leaf', from: 'packages/shared/x.ts', to: 'packages/db/y.ts' },
				],
			},
		})
		expect(report.conclusion).toBe('failure')
		expect(report.totals.boundary_violations.new).toBe(1)
		expect(report.summary).toContain('web-no-server-apps')
	})

	it('extracts cognitive complexity diagnostics and diffs by {file, fn=Line}', () => {
		const biomeDiagnostic = (file: string, prefixText: string, complexity: number) => ({
			category: 'lint/complexity/noExcessiveCognitiveComplexity',
			description: `Excessive complexity of ${complexity} detected (max: 15).`,
			location: {
				path: { file: `./${file}` },
				sourceCode: `${prefixText}\nexport function foo() {}\n`,
				span: [prefixText.length + 1, prefixText.length + 5],
			},
		})
		const report = run({
			biome: {
				diagnostics: [biomeDiagnostic('a.ts', 'line1\nline2', 18), biomeDiagnostic('b.ts', '', 20)],
			},
			baseline: {
				// File a.ts with the same computed line number is baselined.
				cognitive_complexity: [{ file: 'a.ts', fn: 'L3', score: 18 }],
			},
		})
		expect(report.conclusion).toBe('failure')
		expect(report.totals.cognitive_complexity.total).toBe(2)
		expect(report.totals.cognitive_complexity.baseline).toBe(1)
		expect(report.totals.cognitive_complexity.new).toBe(1)
		expect(report.summary).toContain('b.ts')
	})

	it('diffs oversized files by path, ignoring LOC in baseline', () => {
		const report = run({
			filesize: [
				{ file: 'a.ts', loc: 700 },
				{ file: 'b.ts', loc: 800 },
			],
			baseline: {
				oversized_files: [{ file: 'a.ts', loc: 620 }],
			},
		})
		expect(report.conclusion).toBe('failure')
		expect(report.totals.oversized_files.new).toBe(1)
		expect(report.summary).toContain('b.ts')
	})

	it('flags baseline-missing in the summary and treats every violation as new', () => {
		const report = run({
			filesize: [{ file: 'a.ts', loc: 700 }],
			// no baseline written
		})
		expect(report.conclusion).toBe('failure')
		expect(report.summary).toContain('Baseline not present')
		expect(report.totals.oversized_files.new).toBe(1)
	})
})
