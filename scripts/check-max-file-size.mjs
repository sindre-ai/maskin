#!/usr/bin/env node
// File-size fitness check for the maskin/fitness suite (ADR Decisions 3 & 5).
//
// Reads `.maskin/fitness-rules.yml` for the threshold and exclusion globs,
// walks the repo tree, and reports any source file whose LOC exceeds the
// threshold. LOC is counted as physical lines whose `.trim()` is non-empty —
// a stable, whitespace-only-formatter-safe measure that matches what most
// engineers mean by "lines of code" when reviewing a diff.
//
// Sources considered: `.ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts`.
//
// Baseline diff: entries already listed in `.maskin/fitness-baseline.json`
// under `oversized_files` are accepted debt. The match is path-only — a
// baselined file stays accepted until T4's `pnpm fitness:baseline --remove`
// clears it. This is the ratchet: fail on NEW oversize, not on growth of
// already-known offenders (that's `tech-debt-triage`'s job).
//
// Baseline mutation is out of scope here — that belongs to `pnpm
// fitness:baseline` (T4). This script only reads the baseline.
//
// Usage:
//   node scripts/check-max-file-size.mjs
//     Default. Emits JSON `[{file, loc}, ...]` of NEW offenders on stdout.
//     Exits 1 if any new offender exists, 0 otherwise. Human-readable
//     summary goes to stderr.
//
//   node scripts/check-max-file-size.mjs --all
//     Emits JSON `[{file, loc}, ...]` of ALL oversized files on stdout,
//     regardless of baseline. Always exits 0. Used by T4's baseline seeder.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RULES_PATH = '.maskin/fitness-rules.yml'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const HARD_SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.turbo',
	'.next',
	'.pnpm-store',
	'coverage',
	'.cache',
	'.wrangler',
	'.vercel',
	'.output',
])

function main() {
	const args = process.argv.slice(2)
	const mode = args.includes('--all') ? 'all' : 'diff'

	const rules = loadRules(join(REPO_ROOT, RULES_PATH))
	const threshold = rules.max_file_size_loc
	const exclusionRegexes = rules.exclusions.map(compileGlob)
	const baselinePaths = readBaselinePaths(join(REPO_ROOT, rules.baseline_path))

	const oversized = []
	for (const file of walk(REPO_ROOT)) {
		const rel = toPosix(relative(REPO_ROOT, file))
		if (!SOURCE_EXTENSIONS.has(extname(rel))) continue
		if (exclusionRegexes.some((re) => re.test(rel))) continue
		const loc = countLoc(file)
		if (loc > threshold) oversized.push({ file: rel, loc })
	}
	oversized.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

	if (mode === 'all') {
		process.stdout.write(`${JSON.stringify(oversized, null, 2)}\n`)
		process.stderr.write(
			`file-size check: ${oversized.length} oversized file(s) (>${threshold} LOC).\n`,
		)
		process.exit(0)
	}

	const newOffenders = oversized.filter((entry) => !baselinePaths.has(entry.file))
	process.stdout.write(`${JSON.stringify(newOffenders, null, 2)}\n`)
	const baselineNote = baselinePaths.size
		? ` (${baselinePaths.size} baselined)`
		: ' (no baseline present)'
	process.stderr.write(
		`file-size check: ${oversized.length} oversized${baselineNote}; ${newOffenders.length} new offender(s) over ${threshold} LOC.\n`,
	)
	if (newOffenders.length > 0) {
		for (const { file, loc } of newOffenders) {
			process.stderr.write(`  ${file} — ${loc} LOC\n`)
		}
		process.exit(1)
	}
	process.exit(0)
}

function loadRules(path) {
	let raw
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			fail(`missing ${RULES_PATH} — expected at repo root per ADR Decision 5.`)
		}
		throw err
	}
	const parsed = parseRulesYaml(raw)
	if (typeof parsed.max_file_size_loc !== 'number' || parsed.max_file_size_loc <= 0) {
		fail(`${RULES_PATH}: max_file_size_loc must be a positive integer.`)
	}
	if (!Array.isArray(parsed.exclusions)) {
		fail(`${RULES_PATH}: exclusions must be a YAML list.`)
	}
	if (typeof parsed.baseline_path !== 'string' || !parsed.baseline_path) {
		fail(`${RULES_PATH}: baseline_path must be a non-empty string.`)
	}
	return parsed
}

// Minimal YAML reader for this file's fixed shape:
//   max_file_size_loc: <int>
//   exclusions:
//     - "pattern"
//     - pattern
//   baseline_path: <string>
// If the shape grows beyond three keys, swap for the `yaml` package.
function parseRulesYaml(raw) {
	const out = { max_file_size_loc: null, exclusions: [], baseline_path: null }
	let listKey = null
	for (const line of raw.split(/\r?\n/)) {
		const stripped = line.replace(/#.*$/, '').replace(/\s+$/, '')
		if (!stripped.trim()) continue
		listKey = handleYamlLine(stripped, out, listKey)
	}
	return out
}

function handleYamlLine(stripped, out, listKey) {
	const listItem = stripped.match(/^\s+-\s*(.+)$/)
	if (listItem && listKey) {
		out[listKey].push(unquote(listItem[1].trim()))
		return listKey
	}
	const kv = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
	if (!kv) return listKey
	const [, key, valueRaw] = kv
	const value = valueRaw.trim()
	if (value === '') {
		return key in out && Array.isArray(out[key]) ? key : null
	}
	assignScalar(out, key, value)
	return null
}

function assignScalar(out, key, value) {
	if (key === 'max_file_size_loc') {
		const n = Number.parseInt(unquote(value), 10)
		out.max_file_size_loc = Number.isFinite(n) ? n : null
	} else if (key === 'baseline_path') {
		out.baseline_path = unquote(value)
	}
}

function unquote(s) {
	if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
		return s.slice(1, -1)
	}
	return s
}

function readBaselinePaths(path) {
	let raw
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if (err && err.code === 'ENOENT') return new Set()
		throw err
	}
	const parsed = JSON.parse(raw)
	const entries = Array.isArray(parsed?.oversized_files) ? parsed.oversized_files : []
	return new Set(entries.map((e) => e?.file).filter((f) => typeof f === 'string'))
}

function* walk(root) {
	const stack = [root]
	while (stack.length > 0) {
		const dir = stack.pop()
		const entries = readEntries(dir)
		for (const entry of entries) {
			yield* handleEntry(dir, entry, stack)
		}
	}
}

function readEntries(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

function* handleEntry(dir, entry, stack) {
	if (HARD_SKIP_DIRS.has(entry.name)) return
	const full = join(dir, entry.name)
	if (entry.isDirectory()) {
		stack.push(full)
	} else if (entry.isFile()) {
		yield full
	} else if (entry.isSymbolicLink() && isFileTarget(full)) {
		yield full
	}
}

function isFileTarget(full) {
	try {
		return statSync(full).isFile()
	} catch {
		return false
	}
}

function countLoc(file) {
	const text = readFileSync(file, 'utf8')
	let count = 0
	let start = 0
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charCodeAt(i) === 10) {
			const slice = text.slice(start, i)
			// strip trailing \r for CRLF
			const trimmed = slice.replace(/\r$/, '').trim()
			if (trimmed.length > 0) count++
			start = i + 1
		}
	}
	return count
}

function extname(path) {
	const i = path.lastIndexOf('.')
	if (i < 0) return ''
	const slash = path.lastIndexOf('/')
	if (slash > i) return ''
	return path.slice(i).toLowerCase()
}

function toPosix(path) {
	return sep === '/' ? path : path.split(sep).join('/')
}

// Compile a `.gitignore`-flavoured glob into a regex anchored on path
// boundaries. Supports `**`, `*`, and `?`. A pattern with no `/` matches any
// basename; otherwise the pattern may appear at any path depth (i.e. an
// implicit `**/` prefix for relative patterns) and is anchored to end-of-path
// or a `/` terminator.
function compileGlob(pattern) {
	const body = globToRegex(pattern)
	return new RegExp(`(^|/)${body}(?:$|/)`)
}

function globToRegex(pattern) {
	let out = ''
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]
		if (c === '*' && pattern[i + 1] === '*') {
			out += '.*'
			i++
			if (pattern[i + 1] === '/') i++
		} else if (c === '*') {
			out += '[^/]*'
		} else if (c === '?') {
			out += '[^/]'
		} else if ('.+^${}()|[]\\'.includes(c)) {
			out += `\\${c}`
		} else {
			out += c
		}
	}
	return out
}

function fail(msg) {
	process.stderr.write(`file-size check: ${msg}\n`)
	process.exit(2)
}

main()
