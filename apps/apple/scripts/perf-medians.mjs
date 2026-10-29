#!/usr/bin/env node
// Prints the median (and min..max) of every XCTest `measured [...]` line in an xcodebuild log.
//   node scripts/perf-medians.mjs test.log
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const re = /Test Case '-\[\S+ (\w+)\]' measured \[([^\]]+)\] average: ([\d.eE+-]+).*?values: \[([^\]]*)\]/g
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
let found = false
for (const [, test, metric, , values] of text.matchAll(re)) {
	const xs = values.split(',').map((v) => Number(v.trim())).filter(Number.isFinite)
	if (!xs.length) continue
	found = true
	console.log(
		`${test.padEnd(22)} ${metric.padEnd(44)} median ${median(xs).toFixed(3).padStart(12)}  ` +
			`range ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)}  n=${xs.length}`,
	)
}
if (!found) {
	console.error('no measured lines found; last lines of the log:')
	console.error(text.split('\n').slice(-15).join('\n'))
	process.exit(1)
}
