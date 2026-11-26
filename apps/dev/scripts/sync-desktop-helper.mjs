// Rewrites src/lib/desktop-helper-source.ts from docker/desktop/desktopd.py. Run it after
// changing desktopd.py: node apps/dev/scripts/sync-desktop-helper.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync(new URL('../../../docker/desktop/desktopd.py', import.meta.url), 'utf8')
const out = new URL('../src/lib/desktop-helper-source.ts', import.meta.url)
writeFileSync(
	out,
	`// Generated from docker/desktop/desktopd.py by apps/dev/scripts/sync-desktop-helper.mjs. Do not\n// edit by hand: a test fails when it differs from the file.\nexport const DESKTOP_HELPER_SOURCE = ${JSON.stringify(source)}\n`,
)
