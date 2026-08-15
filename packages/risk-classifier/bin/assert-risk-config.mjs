#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { assertMaskinConfigResolves } from '../dist/lib/assert-config.js'

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: { repo: { type: 'string' } },
})

const repo = path.resolve(values.repo ?? process.cwd())
const errors = assertMaskinConfigResolves(repo)

if (errors.length > 0) {
	process.stderr.write(
		'risk-classifier: floor config files failed to resolve — R4 (risk-gate skill) requires a human on every merge until this is fixed:\n',
	)
	for (const e of errors) process.stderr.write(`  - ${e.relPath}: ${e.reason}\n`)
	process.exit(1)
}

process.stdout.write(
	'risk-classifier: all floor config files resolved (.maskin/protected-paths.yml, .maskin/risk-floors.yml, .maskin/hot-tables.yml)\n',
)
process.exit(0)
