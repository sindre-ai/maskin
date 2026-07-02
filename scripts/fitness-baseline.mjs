#!/usr/bin/env node
// Seeds/regenerates .maskin/fitness-baseline.json — the ratchet baseline for
// the maskin/fitness suite (ADR Decision 4). The output is deterministic
// across runs on the same tree: stable sort on every array, no timestamps,
// no absolute paths, repo-relative POSIX only, pretty-printed with a trailing
// newline.
//
// The shape mirrors the three sub-signals plus cycles:
//   {
//     "cycles":               [{ "cycle": ["a", "b", "a"] }, ...],
//     "boundary_violations":  [{ "from", "to", "rule" }, ...],
//     "cognitive_complexity": [{ "file", "fn", "score" }, ...],
//     "oversized_files":      [{ "file", "loc" }, ...]
//   }
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
const RESERVED_WORDS = new Set([
	'if',
	'else',
	'for',
	'while',
	'switch',
	'case',
	'return',
	'const',
	'let',
	'var',
	'function',
	'class',
	'import',
	'export',
	'default',
	'new',
	'try',
	'catch',
	'throw',
	'async',
	'await',
	'yield',
	'static',
	'public',
	'private',
	'protected',
	'get',
	'set',
	'of',
	'in',
	'do',
	'typeof',
	'instanceof',
])

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
	cycles: (c, targets) => c.cycle.some((n) => matchesAny(n, targets)),
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
		const id = c.cycle.join(' -> ')
		if (current.cycles.some((x) => x.cycle.join(' -> ') === id)) {
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
		if (v.type !== 'cycle') continue
		const names = (v.cycle ?? []).map((n) => normalizePath(n.name))
		if (names.length === 0) continue
		// Rotate the cycle so its identity is invariant under starting-node choice.
		// A cycle a->b->c and b->c->a should collapse to a single entry.
		const canonical = canonicalizeCycle(names)
		const id = canonical.join(' -> ')
		if (seen.has(id)) continue
		seen.add(id)
		out.push({ cycle: canonical })
	}
	return sortBy(out, (c) => c.cycle.join(' -> '))
}

function canonicalizeCycle(names) {
	// Rotate so the lexicographically smallest name is first.
	let minIdx = 0
	for (let i = 1; i < names.length; i++) {
		if (names[i] < names[minIdx]) minIdx = i
	}
	return names.slice(minIdx).concat(names.slice(0, minIdx))
}

function extractBoundaryViolations(dc) {
	const out = []
	const seen = new Set()
	for (const v of dc?.summary?.violations ?? []) {
		if (v.type === 'cycle') continue
		if (v.rule?.severity !== 'error') continue
		const from = normalizePath(v.from)
		const to = normalizePath(v.to)
		const rule = v.rule.name
		const key = `${rule}|${from}|${to}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ from, to, rule })
	}
	return sortBy(out, (v) => `${v.rule}\t${v.from}\t${v.to}`)
}

function extractCognitiveComplexity(bi) {
	const out = []
	const seen = new Set()
	for (const d of bi?.diagnostics ?? []) {
		if (d.category !== BIOME_CATEGORY) continue
		const file = normalizePath(d.location?.path?.file ?? '')
		const [s, e] = d.location?.span ?? [0, 0]
		const fn = extractFunctionName(d.location?.sourceCode ?? '', s, e)
		const score = extractScore(d.description ?? '')
		if (!file || !fn) continue
		const key = `${file}|${fn}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ file, fn, score })
	}
	return sortBy(out, (x) => `${x.file}\t${x.fn}`)
}

function extractScore(desc) {
	const m = desc.match(/complexity of (\d+)/)
	return m ? Number(m[1]) : 0
}

// Biome's span often lands mid-signature or even mid-body — the reported
// region is the "problem area" rather than the name. Walk backwards line by
// line from the span's line until we hit a function/method declaration. That
// keeps the recorded `fn` stable when unrelated code above shifts the file's
// byte offsets (rebases, adjacent inserts) — an unstable `fn` would spuriously
// force a NEW-violation failure at ratchet time and break the whole point of
// the baseline. Cap the walk at 200 lines to avoid pathological files.
function extractFunctionName(src, spanStart, spanEnd) {
	if (!src) return null
	const spanLineStart = Math.max(0, src.lastIndexOf('\n', spanStart - 1) + 1)
	const spanLineEndRaw = src.indexOf('\n', spanEnd)
	const spanLineEnd = spanLineEndRaw < 0 ? src.length : spanLineEndRaw
	const spanLine = src.slice(spanLineStart, spanLineEnd)

	// The span line itself may carry a multi-line signature opener like
	// `methodName(` — accept the looser match here since we know biome
	// pointed at this line for a reason.
	const fromSpanLine = matchFunctionDecl(spanLine, { allowMultilineOpener: true })
	if (fromSpanLine) return fromSpanLine

	// Walk backwards up to 200 lines. Disable the multi-line opener match here —
	// otherwise Drizzle-style chains (`and(\n\t...\n)`) get mistaken for a decl.
	let cursor = spanLineStart - 1
	for (let i = 0; i < 200 && cursor > 0; i++) {
		const prevStart = Math.max(0, src.lastIndexOf('\n', cursor - 1) + 1)
		const line = src.slice(prevStart, cursor)
		const hit = matchFunctionDecl(line, { allowMultilineOpener: false })
		if (hit) return hit
		cursor = prevStart - 1
	}
	return null
}

function matchFunctionDecl(line, { allowMultilineOpener }) {
	// `function foo(` / `async function foo(` / `export function foo(`
	let m = line.match(/function\s+([A-Za-z_$][\w$]*)/)
	if (m) return m[1]

	// `const foo = ...` where the RHS is an arrow, function expr, or type-arg opener.
	m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*|\(|<)/)
	if (m) return m[1]

	// Class method — leading whitespace + optional modifiers + name + args + `{` at
	// end of line. The trailing `{` discriminates a method definition from a call
	// like `foo(bar) {…}` block statement, and `[^=>{;]*` inside the parens rules
	// out arrow-callback calls like `setTimeout(() => {`.
	m = line.match(
		/^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^=>{;]*\)[^{;=]*\{\s*$/,
	)
	if (m && !RESERVED_WORDS.has(m[1])) return m[1]

	// Multi-line class-method signature — only permitted on the span line itself;
	// during walkback it produces false positives on function-call chains like
	// Drizzle's `and(\n\t...\n)`.
	if (allowMultilineOpener) {
		m = line.match(
			/^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(\s*$/,
		)
		if (m && !RESERVED_WORDS.has(m[1])) return m[1]
	}

	// Object literal method / property assigned to a function
	m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?\(/)
	if (m && !RESERVED_WORDS.has(m[1])) return m[1]

	return null
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
