import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertMaskinConfigResolves } from '../lib/assert-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('assertMaskinConfigResolves', () => {
	let repoRoot: string

	beforeEach(() => {
		repoRoot = mkdtempSync(path.join(tmpdir(), 'risk-classifier-assert-config-'))
		mkdirSync(path.join(repoRoot, '.maskin'), { recursive: true })
	})

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true })
	})

	function writeFloorFiles(overrides: Partial<Record<string, string>> = {}) {
		const files: Record<string, string> = {
			'protected-paths.yml': 'protected_paths:\n  - "packages/auth/**"\n',
			'risk-floors.yml': 'regex_floors:\n  - pattern: "AKIA[0-9A-Z]{16}"\n    description: test\n',
			'hot-tables.yml': 'hot_tables:\n  - webhook_deliveries\n',
			...overrides,
		}
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(path.join(repoRoot, '.maskin', name), content)
		}
	}

	it('returns no errors when all three floor files resolve', () => {
		writeFloorFiles()
		expect(assertMaskinConfigResolves(repoRoot)).toEqual([])
	})

	it('reports a missing file as "file not found"', () => {
		writeFloorFiles()
		rmSync(path.join(repoRoot, '.maskin', 'risk-floors.yml'))

		const errors = assertMaskinConfigResolves(repoRoot)
		expect(errors).toEqual([{ relPath: '.maskin/risk-floors.yml', reason: 'file not found' }])
	})

	it('reports all three files missing when none exist', () => {
		const errors = assertMaskinConfigResolves(repoRoot)
		expect(errors).toHaveLength(3)
		expect(errors.map((e) => e.relPath)).toEqual([
			'.maskin/protected-paths.yml',
			'.maskin/risk-floors.yml',
			'.maskin/hot-tables.yml',
		])
	})

	it('reports a schema violation rather than silently accepting malformed YAML', () => {
		writeFloorFiles({ 'protected-paths.yml': 'protected_paths: "not-an-array"\n' })

		const errors = assertMaskinConfigResolves(repoRoot)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.relPath).toBe('.maskin/protected-paths.yml')
	})

	it("resolves this repo's real .maskin config with no errors", () => {
		const realRepoRoot = path.resolve(__dirname, '../../../..')
		expect(assertMaskinConfigResolves(realRepoRoot)).toEqual([])
	})
})
