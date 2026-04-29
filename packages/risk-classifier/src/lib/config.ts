import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { HotTablesFileSchema, ProtectedPathsFileSchema, RegexFloorsFileSchema } from '../types.js'
import type { RegexFloor } from '../types.js'

export interface MaskinConfig {
	protected_paths: string[]
	regex_floors: RegexFloor[]
	hot_tables: string[]
}

export function loadMaskinConfig(repoRoot: string): MaskinConfig {
	return {
		protected_paths: readProtectedPaths(repoRoot),
		regex_floors: readRegexFloors(repoRoot),
		hot_tables: readHotTables(repoRoot),
	}
}

function readProtectedPaths(repoRoot: string): string[] {
	const raw = readOptional(path.join(repoRoot, '.maskin/protected-paths.yml'))
	if (!raw) return []
	return ProtectedPathsFileSchema.parse(parseYaml(raw)).protected_paths
}

function readRegexFloors(repoRoot: string): RegexFloor[] {
	const raw = readOptional(path.join(repoRoot, '.maskin/risk-floors.yml'))
	if (!raw) return []
	return RegexFloorsFileSchema.parse(parseYaml(raw)).regex_floors
}

function readHotTables(repoRoot: string): string[] {
	const raw = readOptional(path.join(repoRoot, '.maskin/hot-tables.yml'))
	if (!raw) return []
	return HotTablesFileSchema.parse(parseYaml(raw)).hot_tables
}

function readOptional(file: string): string | null {
	try {
		return readFileSync(file, 'utf8')
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw err
	}
}
