import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const GUARD = resolve(__dirname, '../../../../../scripts/lib/docker-absent-guard.sh')

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'docker-guard-'))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function runGuard(env: Record<string, string>) {
	const result = spawnSync(
		'bash',
		[
			'-c',
			`source "${GUARD}"; maskin_docker_absent_guard; rc=$?; echo "FLAG=\${MASKIN_DOCKER_UNAVAILABLE:-unset}"; exit $rc`,
		],
		{
			env: { PATH: process.env.PATH ?? '', ...env },
			encoding: 'utf8',
		},
	)
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('scripts/lib/docker-absent-guard.sh', () => {
	it('names the missing socket and sets MASKIN_DOCKER_UNAVAILABLE', () => {
		const socket = join(dir, 'absent.sock')
		const out = runGuard({ DOCKER_HOST: `unix://${socket}` })
		expect(out.status).toBe(0)
		expect(out.stderr).toContain(`no Docker socket at ${socket}`)
		expect(out.stdout).toContain('FLAG=1')
	})

	it('exits non-zero naming the socket when MASKIN_REQUIRE_DOCKER=1', () => {
		const socket = join(dir, 'absent.sock')
		const out = runGuard({ DOCKER_HOST: `unix://${socket}`, MASKIN_REQUIRE_DOCKER: '1' })
		expect(out.status).not.toBe(0)
		expect(out.stderr).toContain(`no Docker socket at ${socket}`)
		expect(out.stdout).toContain('FLAG=unset')
	})

	it.each(['tcp://127.0.0.1:2375', 'http://docker.internal:2375'])(
		'leaves the flag unset for the non-unix DOCKER_HOST %s',
		(host) => {
			const out = runGuard({ DOCKER_HOST: host })
			expect(out.status).toBe(0)
			expect(out.stderr).not.toContain('no Docker socket')
			expect(out.stdout).toContain('FLAG=unset')
		},
	)

	it('leaves the flag unset when the socket exists', async () => {
		const socket = join(dir, 'present.sock')
		const server = createServer()
		await new Promise<void>((done) => server.listen(socket, done))
		try {
			const out = runGuard({ DOCKER_HOST: `unix://${socket}` })
			expect(out.status).toBe(0)
			expect(out.stderr).toBe('')
			expect(out.stdout).toContain('FLAG=unset')
		} finally {
			await new Promise((done) => server.close(done))
		}
	})
})
