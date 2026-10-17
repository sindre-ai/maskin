// Writes (or with --check, verifies) docs/reference/mcp-conformance.md.
//   pnpm --filter @maskin/mcp conformance:docs            write the page
//   pnpm --filter @maskin/mcp conformance:docs -- --check fail if it is stale

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderConformanceDocs } from './docs'

const here = dirname(fileURLToPath(import.meta.url))
const page = join(here, '..', '..', '..', '..', '..', 'docs', 'reference', 'mcp-conformance.md')

// The page's last_updated date is part of the file, so --check compares
// everything except that one line; otherwise the check would fail every day.
const DATE_LINE = /^last_updated: .*$/m

function render(today: string): string {
	return renderConformanceDocs(today)
}

const check = process.argv.includes('--check')
const current = existsSync(page) ? readFileSync(page, 'utf8') : ''
const keptDate = current.match(/^last_updated: (.*)$/m)?.[1]
const today = new Date().toISOString().slice(0, 10)

if (check) {
	const expected = render(keptDate ?? today)
	if (current.replace(DATE_LINE, '') !== expected.replace(DATE_LINE, '')) {
		console.error(
			'docs/reference/mcp-conformance.md is out of date. Run: pnpm --filter @maskin/mcp conformance:docs',
		)
		process.exit(1)
	}
	console.log('docs/reference/mcp-conformance.md is up to date')
} else {
	const next = render(today)
	// Keep the existing date when nothing else changed, so regenerating is a no-op diff.
	const sameBody = current.replace(DATE_LINE, '') === next.replace(DATE_LINE, '')
	writeFileSync(page, sameBody && keptDate ? render(keptDate) : next)
	console.log(`wrote ${page}`)
}
