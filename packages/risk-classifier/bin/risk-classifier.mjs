#!/usr/bin/env node
import { runCli } from '../dist/cli.js'

try {
	const { exitCode, stdout } = runCli(process.argv.slice(2))
	process.stdout.write(`${stdout}\n`)
	process.exit(exitCode)
} catch (err) {
	process.stderr.write(`risk-classifier: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(64)
}
