#!/usr/bin/env node
// Prints the spec files one CI shard should run: `node scripts/shard-specs.mjs <shard> <total>`.
//
// Why not `playwright test --shard=N/M`? With fullyParallel off, Playwright cuts the
// alphabetical list of spec files into M contiguous slices of equal test COUNT, so it is
// blind to how long a test takes. The three chat-log-stream specs wait out real client
// timers (a 6s poll, a 33s backgrounded tab) at about 40 to 57s per test, sort next to each
// other, and landed together in one shard that took 9 minutes while the others took 3 to 4.
//
// This greedy-packs whole files by estimated seconds instead (longest first, onto the
// emptiest shard), so a slow file can no longer drag its neighbours into the same shard.
// A file costs DEFAULT_SECONDS_PER_TEST per test unless shard-weights.json says otherwise.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SECONDS_PER_TEST = 1.5

const [shard, total] = process.argv.slice(2).map(Number)
if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) {
	console.error('usage: shard-specs.mjs <shard> <total>   (1-based, shard <= total)')
	process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const secondsPerTest = JSON.parse(readFileSync(join(root, 'scripts/shard-weights.json'), 'utf8'))

const list = JSON.parse(
	execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit'],
	}),
)
if (list.errors?.length > 0) {
	console.error('[shard-specs] playwright --list reported errors:', JSON.stringify(list.errors))
	process.exit(1)
}

const testCounts = new Map()
const walk = (suite) => {
	for (const spec of suite.specs ?? []) {
		testCounts.set(spec.file, (testCounts.get(spec.file) ?? 0) + spec.tests.length)
	}
	for (const child of suite.suites ?? []) walk(child)
}
for (const suite of list.suites) walk(suite)

const files = [...testCounts].map(([file, tests]) => ({
	file,
	seconds: tests * (secondsPerTest[file] ?? DEFAULT_SECONDS_PER_TEST),
}))
files.sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))

const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] }))
for (const f of files) {
	const emptiest = shards.reduce((min, s) => (s.seconds < min.seconds ? s : min))
	emptiest.seconds += f.seconds
	emptiest.files.push(f.file)
}

// Every shard derives the same split from the same input; a file in no shard would be a
// test that silently never runs, so prove the split covers everything once.
const assigned = shards.flatMap((s) => s.files)
if (assigned.length !== files.length || new Set(assigned).size !== files.length) {
	console.error('[shard-specs] split does not cover every spec file exactly once')
	process.exit(1)
}
const mine = shards[shard - 1]
if (mine.files.length === 0) {
	console.error(`[shard-specs] shard ${shard}/${total} got no files (only ${files.length} specs)`)
	process.exit(1)
}

const estimates = shards.map((s) => Math.round(s.seconds)).join(', ')
console.error(
	`[shard-specs] shard ${shard}/${total}: ${mine.files.length} files, estimates: ${estimates}`,
)
for (const file of mine.files.sort()) console.log(`src/tests/${file}`)
