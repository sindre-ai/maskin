import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { HotTablesFileSchema, ProtectedPathsFileSchema, RegexFloorsFileSchema } from '../types.js'

export interface FloorConfigError {
	relPath: string
	reason: string
}

const REQUIRED_FLOOR_FILES = [
	{ relPath: '.maskin/protected-paths.yml', schema: ProtectedPathsFileSchema },
	{ relPath: '.maskin/risk-floors.yml', schema: RegexFloorsFileSchema },
	{ relPath: '.maskin/hot-tables.yml', schema: HotTablesFileSchema },
] as const

/**
 * `loadMaskinConfig` degrades a missing floor file to an empty array so the
 * classifier can always produce a verdict. That's correct for the scoring
 * run itself, but it means a renamed or accidentally-deleted floor file
 * fails *silently* — the protected-path/regex floors just stop binding with
 * no error. This is R4 in the `risk-gate` skill: an unresolvable floor must
 * fail closed, not disappear quietly. CI calls this, separately from
 * scoring, to fail loudly instead.
 */
export function assertMaskinConfigResolves(repoRoot: string): FloorConfigError[] {
	const errors: FloorConfigError[] = []
	for (const { relPath, schema } of REQUIRED_FLOOR_FILES) {
		let raw: string
		try {
			raw = readFileSync(path.join(repoRoot, relPath), 'utf8')
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			errors.push({ relPath, reason: code === 'ENOENT' ? 'file not found' : String(err) })
			continue
		}
		try {
			schema.parse(parseYaml(raw))
		} catch (err) {
			errors.push({ relPath, reason: err instanceof Error ? err.message : String(err) })
		}
	}
	return errors
}
