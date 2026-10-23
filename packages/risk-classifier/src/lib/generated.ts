import { globMatch } from './match.js'

/**
 * Files a tool writes, not a person. They are left out of every count and every gate: nobody
 * reviews them line by line, and a change in them follows from a change somewhere else.
 */
const GENERATED_PATHS = [
	'apps/apple/**/openapi.json',
	'apps/apple/**/Generated/**',
	'packages/db/drizzle/meta/**',
	'**/pnpm-lock.yaml',
	'**/package-lock.json',
	'**/yarn.lock',
	'**/bun.lock',
	'**/bun.lockb',
	'**/Cargo.lock',
	'**/Package.resolved',
]

export function isGeneratedFile(path: string): boolean {
	return GENERATED_PATHS.some((pattern) => globMatch(pattern, path))
}
