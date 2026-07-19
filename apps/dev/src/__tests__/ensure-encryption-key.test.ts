import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Exercises the real script at scripts/ensure-encryption-key.mjs by spawning it
// in an isolated cwd — this is a repo-root tool with no package.json of its own,
// so it isn't covered by any workspace's `pnpm test`. Spawning avoids importing
// the script (it runs its logic at module top level, including process.exit).
const SCRIPT_PATH = join(__dirname, '../../../../scripts/ensure-encryption-key.mjs')

function runScript(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
	try {
		const stdout = execFileSync('node', [SCRIPT_PATH, ...args], {
			cwd,
			env: { ...process.env, ...env },
			encoding: 'utf-8',
		})
		return { status: 0, stdout, stderr: '' }
	} catch (err) {
		const e = err as { status: number; stdout: string; stderr: string }
		return { status: e.status, stdout: e.stdout, stderr: e.stderr }
	}
}

describe('ensure-encryption-key.mjs', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ensure-encryption-key-'))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it('exits 1 and writes no DATABASE_URL when --skip-db-default is passed and DATABASE_URL is unset', () => {
		const result = runScript(dir, ['--skip-db-default'], { DATABASE_URL: '' })

		expect(result.status).toBe(1)
		expect(result.stderr).toContain('--skip-db-default was passed')

		const envContent = readFileSync(join(dir, '.env'), 'utf-8')
		expect(envContent).not.toContain('DATABASE_URL=')
		expect(envContent).toMatch(/^INTEGRATION_ENCRYPTION_KEY=[0-9a-f]{64}$/m)
	})

	it('still writes a generated INTEGRATION_ENCRYPTION_KEY before failing fast', () => {
		writeFileSync(join(dir, '.env'), '')
		const result = runScript(dir, ['--skip-db-default'], { DATABASE_URL: '' })

		expect(result.status).toBe(1)
		const envContent = readFileSync(join(dir, '.env'), 'utf-8')
		expect(envContent).toMatch(/INTEGRATION_ENCRYPTION_KEY=[0-9a-f]{64}/)
	})

	it('does not fail when --skip-db-default is passed but DATABASE_URL is already set', () => {
		const result = runScript(dir, ['--skip-db-default'], {
			DATABASE_URL: 'postgresql://user:pass@example.com:5432/db',
		})

		expect(result.status).toBe(0)
		const envContent = readFileSync(join(dir, '.env'), 'utf-8')
		expect(envContent).not.toContain('DATABASE_URL=postgresql://postgres:postgres@localhost')
	})

	it('falls back to the local default DATABASE_URL when --skip-db-default is not passed', () => {
		const result = runScript(dir, [], { DATABASE_URL: '' })

		expect(result.status).toBe(0)
		const envContent = readFileSync(join(dir, '.env'), 'utf-8')
		expect(envContent).toContain(
			'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/maskin',
		)
	})
})
