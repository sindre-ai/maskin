#!/usr/bin/env node
// Aggregator for the `maskin/fitness` check-run (ADR Decision 7).
//
// Reads the three fitness-signal outputs — dep-cruiser JSON, biome JSON
// filtered to `lint/complexity/noExcessiveCognitiveComplexity`, and
// `check-max-file-size.mjs --all` — diffs each against
// `.maskin/fitness-baseline.json`, and writes a single `fitness-report.json`
// consumed by `.github/workflows/fitness.yml`'s `actions/github-script@v7`
// posting step. The output shape mirrors what `risk-score.yml`'s check-run
// step expects: `{name, conclusion, summary}`.
//
// Environment variables (all resolved to repo-root relative paths):
//   DEPCRUISE_JSON   — dep-cruiser --output-type json output    (default: fitness-depcruise.json)
//   BIOME_JSON       — biome --reporter=json output             (default: fitness-biome.json)
//   FILESIZE_JSON    — check-max-file-size.mjs --all output     (default: fitness-filesize.json)
//   BASELINE_JSON    — accepted-debt snapshot (T4-owned)        (default: .maskin/fitness-baseline.json)
//   OUTPUT_JSON      — where to write the check-run payload     (default: fitness-report.json)
//
// Baseline shape (ADR Decision 4):
//   { cycles: [{path: [module, ...]}], boundary_violations: [{rule, from, to}],
//     cognitive_complexity: [{file, fn, score}], oversized_files: [{file, loc}] }
//
// A missing baseline is treated as empty — every violation becomes new. That
// is the correct state before T4 seeds the baseline: the check posts
// `failure`, but it is not yet a required check (T7 flips branch protection).
//
// The script always exits 0 and always writes OUTPUT_JSON, so the workflow's
// posting step runs even when the tree is dirty. Malformed inputs downgrade
// gracefully: the offending signal is skipped and its miss is called out in
// the summary.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_NAME = 'maskin/fitness'

const paths = {
	depcruise: envPath('DEPCRUISE_JSON', 'fitness-depcruise.json'),
	biome: envPath('BIOME_JSON', 'fitness-biome.json'),
	filesize: envPath('FILESIZE_JSON', 'fitness-filesize.json'),
	baseline: envPath('BASELINE_JSON', '.maskin/fitness-baseline.json'),
	output: envPath('OUTPUT_JSON', 'fitness-report.json'),
}

function envPath(name, fallback) {
	return resolve(REPO_ROOT, process.env[name] || fallback)
}

function readJson(path, { optional = false } = {}) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (err) {
		if (optional && err && err.code === 'ENOENT') return null
		throw err
	}
}

function safeReadJson(path, { optional = false } = {}) {
	try {
		return { data: readJson(path, { optional }), error: null }
	} catch (err) {
		return { data: null, error: err.message || String(err) }
	}
}

// --- Signal extractors ------------------------------------------------------

// Cycle key: sorted rotation-invariant path join. dep-cruiser reports the
// same cycle twice (once per starting edge); canonicalising by rotation
// ensures the baseline lookup matches regardless of the entry module.
function canonicalCyclePath(modules) {
	if (!Array.isArray(modules) || modules.length === 0) return ''
	let minIdx = 0
	for (let i = 1; i < modules.length; i++) {
		if (modules[i] < modules[minIdx]) minIdx = i
	}
	const rotated = modules.slice(minIdx).concat(modules.slice(0, minIdx))
	return rotated.join('>')
}

function extractCycle(v, seenCycles) {
	const modules = Array.isArray(v.cycle) ? v.cycle.map((c) => c.name).filter(Boolean) : []
	const key = canonicalCyclePath(modules)
	if (!key || seenCycles.has(key)) return null
	seenCycles.add(key)
	return { key, path: modules }
}

function extractBoundary(v, ruleName) {
	const from = v.from || ''
	const to = v.to || ''
	return { key: `${ruleName}|${from}|${to}`, rule: ruleName, from, to }
}

function extractDepcruise(json) {
	const violations = json?.summary?.violations
	if (!Array.isArray(violations)) return { cycles: [], boundary_violations: [] }
	const cycles = []
	const seenCycles = new Set()
	const boundary = []
	for (const v of violations) {
		const ruleName = v?.rule?.name
		if (!ruleName) continue
		if (ruleName === 'no-circular') {
			const c = extractCycle(v, seenCycles)
			if (c) cycles.push(c)
		} else {
			boundary.push(extractBoundary(v, ruleName))
		}
	}
	return { cycles, boundary_violations: boundary }
}

// Convert a biome span (character offset in the emitted sourceCode) to a 1-based
// line number. Baseline keys use `L{line}` — deliberately fuzzy across
// refactors; T4's seeder uses the same extraction. If the sourceCode isn't
// present, we fall back to the raw offset so the key still distinguishes
// diagnostics within the same file.
function biomeFnIdent(diag) {
	const span = diag?.location?.span
	const startOffset = Array.isArray(span) ? span[0] : null
	const source = diag?.location?.sourceCode
	if (typeof source === 'string' && Number.isFinite(startOffset)) {
		let line = 1
		const end = Math.min(startOffset, source.length)
		for (let i = 0; i < end; i++) {
			if (source.charCodeAt(i) === 10) line++
		}
		return `L${line}`
	}
	return Number.isFinite(startOffset) ? `@${startOffset}` : 'unknown'
}

function biomeScore(diag) {
	const desc = diag?.description || ''
	const m = desc.match(/complexity of (\d+)/i)
	return m ? Number.parseInt(m[1], 10) : null
}

function extractBiome(json) {
	const diagnostics = Array.isArray(json?.diagnostics) ? json.diagnostics : []
	const out = []
	for (const d of diagnostics) {
		if (d?.category !== 'lint/complexity/noExcessiveCognitiveComplexity') continue
		const file = normalizeBiomePath(d?.location?.path?.file)
		if (!file) continue
		const fn = biomeFnIdent(d)
		out.push({ key: `${file}|${fn}`, file, fn, score: biomeScore(d) })
	}
	return out
}

function normalizeBiomePath(path) {
	if (typeof path !== 'string') return null
	// Biome emits `./relative/path.ts` — strip the leading `./`.
	return path.startsWith('./') ? path.slice(2) : path
}

function extractFilesize(json) {
	if (!Array.isArray(json)) return []
	return json
		.filter((e) => e && typeof e.file === 'string')
		.map((e) => ({ key: e.file, file: e.file, loc: e.loc }))
}

// --- Baseline diffing -------------------------------------------------------

function baselineKeys(baseline, signal, keyOf) {
	if (!baseline || typeof baseline !== 'object') return new Set()
	const list = baseline[signal]
	if (!Array.isArray(list)) return new Set()
	const keys = new Set()
	for (const entry of list) {
		const k = keyOf(entry)
		if (k) keys.add(k)
	}
	return keys
}

function diff(current, baselineSet) {
	return current.filter((entry) => !baselineSet.has(entry.key))
}

// --- Summary rendering ------------------------------------------------------

function renderList(title, items, format, cap = 10) {
	if (items.length === 0) return ''
	const shown = items.slice(0, cap).map(format)
	const overflow = items.length > cap ? `\n… and ${items.length - cap} more.` : ''
	return `\n\n### ${title} (${items.length})\n${shown.join('\n')}${overflow}`
}

function renderSummary({ baselineMissing, baselineErrors, signals, totals }) {
	const header = `**Fitness signals** (new violations, baseline-diffed)

| Signal | New | Baseline | Total |
| --- | --- | --- | --- |
| Cycles | ${totals.cycles.new} | ${totals.cycles.baseline} | ${totals.cycles.total} |
| Boundary violations | ${totals.boundary_violations.new} | ${totals.boundary_violations.baseline} | ${totals.boundary_violations.total} |
| Cognitive complexity (>15) | ${totals.cognitive_complexity.new} | ${totals.cognitive_complexity.baseline} | ${totals.cognitive_complexity.total} |
| Oversized files (>600 LOC) | ${totals.oversized_files.new} | ${totals.oversized_files.baseline} | ${totals.oversized_files.total} |`

	const notes = []
	if (baselineMissing) {
		notes.push(
			'\n> **Baseline not present** — every violation is counted as new until `.maskin/fitness-baseline.json` is seeded by `pnpm fitness:baseline` (T4).',
		)
	}
	for (const [signal, msg] of baselineErrors) {
		notes.push(`\n> **${signal} input error** — ${msg}. Signal treated as empty.`)
	}

	const lists = [
		renderList('New cycles', signals.cycles.new, (c) => `- \`${c.path.join(' → ')}\``),
		renderList(
			'New boundary violations',
			signals.boundary_violations.new,
			(b) => `- \`${b.rule}\` — \`${b.from}\` → \`${b.to}\``,
		),
		renderList(
			'New cognitive-complexity',
			signals.cognitive_complexity.new,
			(c) => `- \`${c.file}\` \`${c.fn}\` — score ${c.score ?? '?'}`,
		),
		renderList(
			'New oversized files',
			signals.oversized_files.new,
			(o) => `- \`${o.file}\` — ${o.loc ?? '?'} LOC`,
		),
	].join('')

	return `${header}${notes.join('')}${lists}`
}

// --- Main -------------------------------------------------------------------

function main() {
	const inputs = {
		depcruise: safeReadJson(paths.depcruise),
		biome: safeReadJson(paths.biome),
		filesize: safeReadJson(paths.filesize),
	}
	const baselineRead = safeReadJson(paths.baseline, { optional: true })
	const baselineMissing = baselineRead.data === null && baselineRead.error === null
	const baseline =
		baselineRead.data && typeof baselineRead.data === 'object' ? baselineRead.data : {}

	const baselineErrors = []
	if (baselineRead.error) baselineErrors.push(['baseline', baselineRead.error])
	if (inputs.depcruise.error) baselineErrors.push(['depcruise', inputs.depcruise.error])
	if (inputs.biome.error) baselineErrors.push(['biome', inputs.biome.error])
	if (inputs.filesize.error) baselineErrors.push(['filesize', inputs.filesize.error])

	const dc = extractDepcruise(inputs.depcruise.data)
	const complexity = extractBiome(inputs.biome.data)
	const oversized = extractFilesize(inputs.filesize.data)

	const baselineSets = {
		cycles: baselineKeys(baseline, 'cycles', (e) =>
			canonicalCyclePath(Array.isArray(e?.path) ? e.path : []),
		),
		boundary_violations: baselineKeys(
			baseline,
			'boundary_violations',
			(e) => e && `${e.rule}|${e.from}|${e.to}`,
		),
		cognitive_complexity: baselineKeys(
			baseline,
			'cognitive_complexity',
			(e) => e?.file && e?.fn && `${e.file}|${e.fn}`,
		),
		oversized_files: baselineKeys(baseline, 'oversized_files', (e) => e?.file),
	}

	const signals = {
		cycles: { current: dc.cycles, new: diff(dc.cycles, baselineSets.cycles) },
		boundary_violations: {
			current: dc.boundary_violations,
			new: diff(dc.boundary_violations, baselineSets.boundary_violations),
		},
		cognitive_complexity: {
			current: complexity,
			new: diff(complexity, baselineSets.cognitive_complexity),
		},
		oversized_files: { current: oversized, new: diff(oversized, baselineSets.oversized_files) },
	}

	const totals = Object.fromEntries(
		Object.entries(signals).map(([name, s]) => [
			name,
			{ new: s.new.length, baseline: baselineSets[name].size, total: s.current.length },
		]),
	)

	const newCount = Object.values(totals).reduce((n, t) => n + t.new, 0)
	const conclusion = newCount === 0 ? 'success' : 'failure'

	const summary = renderSummary({ baselineMissing, baselineErrors, signals, totals })

	const report = { name: CHECK_NAME, conclusion, summary, totals }
	writeFileSync(paths.output, `${JSON.stringify(report, null, 2)}\n`)
	process.stderr.write(
		`fitness-report: ${conclusion} — ${newCount} new across ${Object.keys(totals).length} signals.\n`,
	)
	process.exit(0)
}

main()
