#!/usr/bin/env node
// Peak and median resident memory of the app during each scroll test, from the files perf-scroll.sh
// writes: mem-<test>.txt ("<epoch seconds> <KB>" once a second, from ps) and marks-<test>.txt
// ("<epoch seconds> start|stop" around each scroll round, from the test).
//   node scripts/perf-memory.mjs <out dir>
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const rows = (file) =>
	existsSync(file)
		? readFileSync(file, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => line.trim().split(/\s+/))
		: []
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mb = (kb) => (kb / 1024).toFixed(1).padStart(7)

for (const file of readdirSync(dir).filter((f) => /^mem-.+\.txt$/.test(f))) {
	const test = file.slice(4, -4)
	const label = test.padEnd(22)
	const samples = rows(join(dir, file)).map(([t, kb]) => [Number(t), Number(kb)])
	if (!samples.length) {
		console.log(`${label} app memory: no samples (the app process was not found)`)
		continue
	}
	// Scroll windows from the markers. A sample is taken once a second, so it counts when its second
	// falls inside [start, stop].
	const windows = []
	let start = null
	for (const [t, what] of rows(join(dir, `marks-${test}.txt`))) {
		if (what === 'start') start = Number(t)
		else if (what === 'stop' && start !== null) {
			windows.push([Math.floor(start), Number(t)])
			start = null
		}
	}
	const inScroll = samples
		.filter(([t]) => windows.some(([a, b]) => t >= a && t <= b))
		.map(([, kb]) => kb)
	const idle = windows.length ? samples.filter(([t]) => t < windows[0][0]).map(([, kb]) => kb) : []
	if (!inScroll.length) {
		const all = samples.map(([, kb]) => kb)
		console.log(
			`${label} app memory (MB): no samples inside a scroll round (${windows.length} rounds marked); ` +
				`whole test peak ${mb(Math.max(...all))}  median ${mb(median(all))}  n=${all.length}`,
		)
		continue
	}
	const before = idle.length ? `  (before the first scroll: median ${mb(median(idle))})` : ''
	console.log(
		`${label} app memory during scroll (MB): peak ${mb(Math.max(...inScroll))}  median ${mb(median(inScroll))}  n=${inScroll.length} samples over ${windows.length} rounds${before}`,
	)
}
