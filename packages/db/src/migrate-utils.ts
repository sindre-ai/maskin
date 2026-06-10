import { readdirSync } from 'node:fs'

export function listMigrationFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
		.sort()
}
