#!/usr/bin/env node
// Seeds/regenerates .maskin/fitness-baseline.json — the ratchet baseline for
// the maskin/fitness suite (ADR Decision 4). The output is deterministic
// across runs on the same tree: stable sort on every array, no timestamps,
// no absolute paths, repo-relative POSIX only, pretty-printed with a trailing
// newline.
//
// The shape matches what scripts/fitness-report.mjs (T5's aggregator)
// looks up when it diffs current-tree findings against accepted debt:
//   {
//     "cycles":               [{ "path": ["a", "b"] }, ...],
//     "boundary_violations":  [{ "rule", "from", "to" }, ...],
//     "cognitive_complexity": [{ "file", "fn", "score" }, ...],
//     "oversized_files":      [{ "file", "loc" }, ...]
//   }
//
// `cycles.path` is rotation-canonicalised (smallest module name first) so a
// cycle a->b->a and b->a->b collapse to the same entry — matches T5's
// canonicalCyclePath.
//
// `cognitive_complexity.fn` is the T5 `biomeFnIdent` output: `L{1-based line}`
// derived from the biome diagnostic's span. Function-name extraction was
// intentionally rejected — it's not stable when unrelated code above shifts
// byte offsets, whereas line numbers land where the span already points and
// let the aggregator lookup succeed. If line numbers shift too (e.g. a
// refactor lands lines above), the ratchet correctly counts the moved
// finding as a new violation and `pnpm fitness:baseline` regenerates.
//
// Usage:
//   pnpm fitness:baseline
//     Regenerate the whole baseline from the current tree by running
//     dep-cruiser (JSON), Biome (JSON reporter), and check-max-file-size
//     (--all). Writes the file, prints a one-line summary to stderr.
//
//   pnpm fitness:baseline --remove <path> [<path> ...]
//     Drop matching entries from every array. Refuses (non-zero exit, no
//     write) unless re-running the underlying suite confirms every dropped
//     violation is actually gone. This is the honest ratchet: an
//     unconditional delete is exactly what makes baselines rot.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(REPO_ROOT, '.maskin/fitness-baseline.json')
const DEPCRUISE_BIN = join(REPO_ROOT, 'node_modules/.bin/depcruise')
const BIOME_BIN = join(REPO_ROOT, 'node_modules/.bin/biome')
const FILESIZE_SCRIPT = join(REPO_ROOT, 'scripts/check-max-file-size.mjs')

const BIOME_CATEGORY = 'lint/complexity/noExcessiveCognitiveComplexity'

function main() {
	const args = process.argv.slice(2)
	const removeIdx = args.indexOf('--remove')
	if (removeIdx >= 0) {
		removeMode(args.slice(removeIdx + 1))
		return
	}
	seed()
}

// ─── seed mode ────────────────────────────────────────────────────────
function seed() {
	const payload = collectAll()
	writeBaseline(payload)
	const c = counts(payload)
	process.stderr.write(
		`fitness-baseline: seeded — cycles=${c.cycles}, boundary=${c.boundary_violations}, cognitive=${c.cognitive_complexity}, oversized=${c.oversized_files}\n`,
	)
}

// ─── --remove mode ────────────────────────────────────────────────────
function removeMode(rawTargets) {
	const targets = rawTargets.map(normalizePath).filter(Boolean)
	if (targets.length === 0) fail('--remove requires at least one path argument')

	const baseline = readBaseline()
	if (!baseline) fail('no baseline exists at .maskin/fitness-baseline.json — nothing to remove')

	const { removed, kept } = partitionByTargets(baseline, targets)
	const removedCount =
		removed.cycles.length +
		removed.boundary_violations.length +
		removed.cognitive_complexity.length +
		removed.oversized_files.length
	if (removedCount === 0) fail(`no baseline entries matched: ${targets.join(', ')}`)

	// Honest ratchet: refuse if the same violation is still produced by the suite.
	const current = collectAll()
	const stillPresent = findStillPresent(removed, current)
	if (stillPresent.length > 0) {
		process.stderr.write('fitness-baseline: refusing --remove — violation(s) still present:\n')
		for (const line of stillPresent) process.stderr.write(`  ${line}\n`)
		process.stderr.write(
			'Fix the underlying violation first, or run `pnpm fitness:baseline` with no args to regenerate the whole baseline.\n',
		)
		process.exit(1)
	}

	writeBaseline(kept)
	process.stderr.write(
		`fitness-baseline: removed ${removedCount} entry(ies) matching: ${targets.join(', ')}\n`,
	)
}

// Per-array match rules keep partitionByTargets flat: one predicate per bucket
// keyed by the baseline field name, driven by a shared partition helper.
const REMOVE_MATCHERS = {
	cycles: (c, targets) => (c.path ?? []).some((n) => matchesAny(n, targets)),
	boundary_violations: (b, targets) => matchesAny(b.from, targets) || matchesAny(b.to, targets),
	cognitive_complexity: (c, targets) => matchesAny(c.file, targets),
	oversized_files: (o, targets) => matchesAny(o.file, targets),
}

function partitionByTargets(baseline, targets) {
	const removed = {}
	const kept = {}
	for (const [key, match] of Object.entries(REMOVE_MATCHERS)) {
		const partition = partitionArray(baseline[key] ?? [], (entry) => match(entry, targets))
		removed[key] = partition.matched
		kept[key] = partition.rest
	}
	return { removed, kept }
}

function partitionArray(arr, predicate) {
	const matched = []
	const rest = []
	for (const entry of arr) (predicate(entry) ? matched : rest).push(entry)
	return { matched, rest }
}

function findStillPresent(removed, current) {
	const out = []
	for (const c of removed.cycles) {
		const id = (c.path ?? []).join(' -> ')
		if (current.cycles.some((x) => (x.path ?? []).join(' -> ') === id)) {
			out.push(`cycle: ${id}`)
		}
	}
	for (const b of removed.boundary_violations) {
		if (
			current.boundary_violations.some(
				(x) => x.from === b.from && x.to === b.to && x.rule === b.rule,
			)
		) {
			out.push(`boundary: ${b.rule} ${b.from} -> ${b.to}`)
		}
	}
	for (const c of removed.cognitive_complexity) {
		if (current.cognitive_complexity.some((x) => x.file === c.file && x.fn === c.fn)) {
			out.push(`cognitive: ${c.file}:${c.fn}`)
		}
	}
	for (const o of removed.oversized_files) {
		if (current.oversized_files.some((x) => x.file === o.file)) {
			out.push(`oversized: ${o.file}`)
		}
	}
	return out
}

// ─── collectors ───────────────────────────────────────────────────────
function collectAll() {
	const dc = JSON.parse(runCapture(DEPCRUISE_BIN, ['--output-type', 'json', '.']))
	// Biome exits 1 when any diagnostic is emitted (including warns), so accept
	// both 0 and 1 here — the JSON reporter output is valid in either case.
	const bi = JSON.parse(runCapture(BIOME_BIN, ['check', '--reporter=json', '.'], [0, 1]))
	const fs = JSON.parse(runCapture(process.execPath, [FILESIZE_SCRIPT, '--all']))
	return {
		cycles: extractCycles(dc),
		boundary_violations: extractBoundaryViolations(dc),
		cognitive_complexity: extractCognitiveComplexity(bi),
		oversized_files: sortBy(
			(fs ?? []).map((e) => ({ file: normalizePath(e.file), loc: e.loc })),
			(e) => `${e.file}\t${String(e.loc).padStart(10, '0')}`,
		),
	}
}

function extractCycles(dc) {
	const seen = new Set()
	const out = []
	for (const v of dc?.summary?.violations ?? []) {
		if (v?.rule?.name !== 'no-circular') continue
		const modules = Array.isArray(v.cycle) ? v.cycle.map((c) => normalizePath(c.name)) : []
		if (modules.length === 0) continue
		const path = canonicalCyclePath(modules)
		const id = path.join('>')
		if (seen.has(id)) continue
		seen.add(id)
		out.push({ path })
	}
	return sortBy(out, (c) => c.path.join('>'))
}

// Rotate the cycle so the lexicographically smallest module name is first —
// the exact canonicalisation T5's aggregator uses. Ensures dep-cruiser's
// duplicate cycle reports collapse to one baseline entry.
function canonicalCyclePath(modules) {
	let minIdx = 0
	for (let i = 1; i < modules.length; i++) {
		if (modules[i] < modules[minIdx]) minIdx = i
	}
	return modules.slice(minIdx).concat(modules.slice(0, minIdx))
}

function extractBoundaryViolations(dc) {
	const out = []
	const seen = new Set()
	for (const v of dc?.summary?.violations ?? []) {
		const rule = v?.rule?.name
		if (!rule || rule === 'no-circular') continue
		const from = normalizePath(v.from)
		const to = normalizePath(v.to)
		const key = `${rule}|${from}|${to}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ rule, from, to })
	}
	return sortBy(out, (v) => `${v.rule}\t${v.from}\t${v.to}`)
}

function extractCognitiveComplexity(bi) {
	const out = []
	const seen = new Set()
	for (const d of bi?.diagnostics ?? []) {
		if (d?.category !== BIOME_CATEGORY) continue
		const file = normalizePath(d.location?.path?.file ?? '')
		if (!file) continue
		const fn = biomeFnIdent(d)
		const score = extractScore(d.description ?? '')
		const key = `${file}|${fn}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ file, fn, score })
	}
	return sortBy(out, (x) => `${x.file}\t${x.fn}`)
}

// Line-based identifier — matches scripts/fitness-report.mjs::biomeFnIdent
// byte-for-byte so the baseline lookup succeeds. Line number is 1-based.
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

function extractScore(desc) {
	const m = desc.match(/complexity of (\d+)/i)
	return m ? Number.parseInt(m[1], 10) : null
}

// ─── utilities ────────────────────────────────────────────────────────
function normalizePath(p) {
	if (!p) return p
	let s = String(p).replace(/\\/g, '/')
	if (s.startsWith('./')) s = s.slice(2)
	return s
}

function matchesAny(candidate, targets) {
	const c = normalizePath(candidate)
	return targets.some((t) => c === t || c.startsWith(`${t}/`))
}

function sortBy(arr, keyFn) {
	return [...arr].sort((a, b) => {
		const ka = keyFn(a)
		const kb = keyFn(b)
		if (ka < kb) return -1
		if (ka > kb) return 1
		return 0
	})
}

function counts(p) {
	return {
		cycles: p.cycles.length,
		boundary_violations: p.boundary_violations.length,
		cognitive_complexity: p.cognitive_complexity.length,
		oversized_files: p.oversized_files.length,
	}
}

function runCapture(cmd, args, acceptExit = [0]) {
	try {
		return execFileSync(cmd, args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			maxBuffer: 512 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (err) {
		const status = err && typeof err.status === 'number' ? err.status : 'signal'
		if (acceptExit.includes(status) && err.stdout) return err.stdout.toString('utf8')
		const stderrTail = err?.stderr ? String(err.stderr).slice(-400) : ''
		fail(
			`sub-suite failed (${cmd.split('/').pop()}, exit=${status}): ${err.message}${
				stderrTail ? `\n---stderr tail---\n${stderrTail}` : ''
			}`,
		)
	}
}

function writeBaseline(payload) {
	const json = `${JSON.stringify(payload, null, 2)}\n`
	writeFileSync(BASELINE_PATH, json)
	return json
}

function readBaseline() {
	try {
		const raw = readFileSync(BASELINE_PATH, 'utf8')
		return JSON.parse(raw)
	} catch (err) {
		if (err.code === 'ENOENT') return null
		fail(`baseline JSON malformed at ${BASELINE_PATH}: ${err.message}`)
	}
}

function fail(msg) {
	process.stderr.write(`fitness-baseline: ${msg}\n`)
	process.exit(1)
}

main()
