import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const CAPABILITIES_DIR = join(SRC, 'lib/capabilities')

// holders.ts is the single place that answers who may use a source and who may
// be told about it. Everything else on the capability path asks it.
const GUARDED = [
	...readdirSync(CAPABILITIES_DIR)
		.filter((name) => name.endsWith('.ts') && name !== 'holders.ts')
		.map((name) => join(CAPABILITIES_DIR, name)),
	join(SRC, 'services/capability-scanner.ts'),
	// Slices 2 and 3 add these; the guard covers them as soon as they exist.
	join(SRC, 'services/capability-digest.ts'),
	join(SRC, 'services/proactive-message.ts'),
].filter((path) => existsSync(path))

const FORBIDDEN = [
	'transportOf',
	'tools.mcpServers',
	'mcpServers',
	'expose_to_agent_sessions',
	'actors.tools',
	'workspace_grants',
	'workspaceGrants',
	'tool_grants',
]

describe('holders.ts is the single reader of agent tool config', () => {
	it('guards the scanner and every capabilities file except holders.ts', () => {
		expect(GUARDED.length).toBeGreaterThanOrEqual(6)
		expect(GUARDED.some((p) => p.endsWith('services/capability-scanner.ts'))).toBe(true)
		expect(GUARDED.some((p) => p.endsWith('holders.ts'))).toBe(false)
	})

	for (const term of FORBIDDEN) {
		it(`no guarded file mentions ${term}`, () => {
			const offenders = GUARDED.filter((path) => readFileSync(path, 'utf8').includes(term))
			expect(offenders).toEqual([])
		})
	}

	it('no guarded file defines its own role check', () => {
		const offenders = GUARDED.filter((path) =>
			/['"](owner|admin)['"]/.test(readFileSync(path, 'utf8')),
		)
		expect(offenders).toEqual([])
	})
})

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path)
		return path.endsWith('.ts') ? [path] : []
	})
}

describe('transportOf', () => {
	it('is imported from holders.ts only', () => {
		const importers = walk(SRC).filter(
			(path) =>
				!path.endsWith('lib/actor-tools-redaction.ts') &&
				/import[^;]*\btransportOf\b[^;]*actor-tools-redaction/s.test(readFileSync(path, 'utf8')),
		)
		expect(importers.map((p) => p.slice(SRC.length + 1))).toEqual(['lib/capabilities/holders.ts'])
	})
})

describe('holders.ts contract', () => {
	const source = readFileSync(join(CAPABILITIES_DIR, 'holders.ts'), 'utf8')

	it('exports the four contract functions plus the unscanned-server count', () => {
		const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
		expect(exported.sort()).toEqual(
			[
				'countUnscannedServers',
				'holdersForSources',
				'holdersOf',
				'recipientCanAct',
				'visibleHolders',
			].sort(),
		)
	})

	it('reuses the workspace-auth human admin check and writes no role string', () => {
		expect(source).toContain('isWorkspaceHumanAdminOrOwner')
		expect(/['"](owner|admin)['"]/.test(source)).toBe(false)
	})

	it('selects the implementation with one constant', () => {
		expect(source.match(/const HOLDERS_IMPLEMENTATION/g)).toHaveLength(1)
		expect(source).toContain('class AgentConfigHolders')
		expect(source).toContain('class WorkspaceGrantHolders')
	})

	it('never writes agent config, integrations or grants', () => {
		expect(source).not.toMatch(/\.(insert|update|delete)\(/)
	})
})
