import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Drives the real (un-mocked) ensureImage in a child process with the Docker
// socket forced absent. The per-entry tar-stream Sink emits an 'error' that, when
// unhandled, kills the process; the failure must instead surface as a rejection.
// Kept in a child so an unhandled error fails the assertion, not the test runner.
describe('ContainerManager.ensureImage with no Docker socket', () => {
	it('rejects instead of crashing the process', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ensure-image-'))
		try {
			const buildContext = join(dir, 'ctx')
			spawnSync('mkdir', [buildContext])
			// Several large entries: the Sink error only fires for entries still queued
			// behind the first when the daemon request fails and the pack is destroyed.
			for (const name of ['Dockerfile', 'a.txt', 'b.txt', 'c.txt']) {
				writeFileSync(join(buildContext, name), 'x'.repeat(256 * 1024))
			}

			const script = `
				import { ContainerManager } from './src/services/container-manager.ts'
				try {
					await new ContainerManager().ensureImage('absent:latest', ${JSON.stringify(buildContext)})
					console.log('RESOLVED')
				} catch (err) {
					console.log('REJECTED')
				}
			`
			const child = spawnSync(
				process.execPath,
				['--import', 'tsx', '--input-type=module', '-e', script],
				{
					cwd: join(__dirname, '../../..'),
					env: { ...process.env, DOCKER_HOST: `unix://${join(dir, 'absent.sock')}` },
					encoding: 'utf8',
					timeout: 30_000,
				},
			)

			expect(child.stdout).toContain('REJECTED')
			expect(child.status).toBe(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 45_000)
})
