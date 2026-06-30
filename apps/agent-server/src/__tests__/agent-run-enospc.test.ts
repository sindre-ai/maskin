// Synthetic disk-fill coverage for `docker/agent-base/agent-run.sh` (AC-T7).
// We can't reproduce a real ENOSPC inside Vitest without root + a sacrificial
// tmpfs, so we drive the two functions the trap relies on (`detect_disk_full`
// and `report_complete`) via `bash -c "source agent-run.sh; ..."` and assert
// the contract: (1) detection fires on an un-writable workspace, (2) the EXIT
// trap chain overrides AGENT_EXIT_CODE to 28, (3) report_complete POSTs that
// overridden code to /sessions/:id/complete.
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const AGENT_RUN_SH = resolve(
	dirname(__filename),
	'..',
	'..',
	'..',
	'..',
	'docker',
	'agent-base',
	'agent-run.sh',
)

interface BashResult {
	code: number | null
	stdout: string
	stderr: string
}

/**
 * Run a bash snippet that sources agent-run.sh, then executes whatever the
 * caller passes in. We launch `bash -c` directly so the script's `set -e`
 * doesn't take down our test process, and capture stdout/stderr separately
 * so assertions can target the right stream.
 */
async function runBash(snippet: string, env: NodeJS.ProcessEnv = {}): Promise<BashResult> {
	return await new Promise((resolveResult, rejectResult) => {
		const child = spawn('bash', ['-c', snippet], {
			env: { ...process.env, ...env },
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString()
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString()
		})
		child.on('error', rejectResult)
		child.on('close', (code) => {
			resolveResult({ code, stdout, stderr })
		})
	})
}

let tmpRoot: string

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), 'agent-run-enospc-'))
})

afterEach(async () => {
	// Restore writable mode on any chmod-locked subdir so rm can clean up.
	try {
		await chmod(tmpRoot, 0o755)
	} catch {}
	await rm(tmpRoot, { recursive: true, force: true })
})

describe('agent-run.sh detect_disk_full', () => {
	// `source agent-run.sh` re-enables `set -e` (its second line), so after
	// sourcing we drop back to `set +e`. Otherwise a function returning 1 —
	// the success case for detect_disk_full on a writable workspace — would
	// abort the shell before the `echo "rc=$?"` ran.
	it('returns 1 (no disk-full) when the workspace is writable and not near full', async () => {
		// tmpRoot is a fresh writable dir on the test runner's filesystem —
		// even on a tight CI host, /tmp sits well below the 98% threshold.
		const result = await runBash(
			`source "${AGENT_RUN_SH}"; set +e; detect_disk_full "${tmpRoot}"; echo "rc=$?"`,
		)
		expect(result.stdout).toContain('rc=1')
	})

	it('returns 0 (disk-full detected) when the workspace is read-only and the write probe fails', async () => {
		// chmod 0o555 → r-x for everyone, no write bit → creat() returns
		// EACCES, which detect_disk_full treats as the disk-full class
		// because the agent's own writes would have failed the same way.
		await chmod(tmpRoot, 0o555)
		const result = await runBash(
			`source "${AGENT_RUN_SH}"; set +e; detect_disk_full "${tmpRoot}"; echo "rc=$?"`,
		)
		expect(result.stdout).toContain('rc=0')
	})

	it('returns 1 when the workspace path does not exist (setup miss, not disk-full)', async () => {
		const missing = join(tmpRoot, 'nope-not-here')
		const result = await runBash(
			`source "${AGENT_RUN_SH}"; set +e; detect_disk_full "${missing}"; echo "rc=$?"`,
		)
		expect(result.stdout).toContain('rc=1')
	})
})

describe('agent-run.sh on_exit trap', () => {
	it('overrides AGENT_EXIT_CODE to 28 when detect_disk_full fires (AC-T7)', async () => {
		// Stub detect_disk_full to return 0 (disk-full detected). on_exit should
		// override the starting AGENT_EXIT_CODE to 28 before report_complete runs.
		// AGENT_SERVER_URL and SESSION_ID are empty so report_complete skips its
		// curl POST — we just need to observe the final overridden code.
		const result = await runBash(
			`
				source "${AGENT_RUN_SH}"
				set +e
				AGENT_EXIT_CODE=1
				detect_disk_full() { return 0; }
				AGENT_SERVER_URL=""
				SESSION_ID=""
				on_exit
				echo "final=$AGENT_EXIT_CODE"
			`,
		)
		expect(result.stdout).toContain('final=28')
		expect(result.stderr).toContain('ENOSPC detected')
		expect(result.stderr).toContain('no recovery session')
	})

	it('keeps the original AGENT_EXIT_CODE when detect_disk_full does not fire', async () => {
		// Stub detect_disk_full to return 1 (no disk-full) — on_exit leaves the
		// original code untouched.
		const result = await runBash(
			`
				source "${AGENT_RUN_SH}"
				set +e
				AGENT_EXIT_CODE=7
				detect_disk_full() { return 1; }
				AGENT_SERVER_URL=""
				SESSION_ID=""
				on_exit
				echo "final=$AGENT_EXIT_CODE"
			`,
		)
		expect(result.stdout).toContain('final=7')
	})
})

describe('agent-run.sh report_complete', () => {
	let server: Server
	let serverUrl: string
	let receivedBody: string | null

	beforeEach(async () => {
		receivedBody = null
		server = createServer((req, res) => {
			let body = ''
			req.on('data', (chunk) => {
				body += chunk.toString()
			})
			req.on('end', () => {
				if (req.method === 'POST' && req.url?.endsWith('/complete')) {
					receivedBody = body
				}
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end('{"ok":true}')
			})
		})
		await new Promise<void>((r) => {
			server.listen(0, '127.0.0.1', r)
		})
		const addr = server.address() as AddressInfo
		serverUrl = `http://127.0.0.1:${addr.port}`
	})

	afterEach(async () => {
		await new Promise<void>((r) => server.close(() => r()))
	})

	it('POSTs the (possibly overridden) AGENT_EXIT_CODE to /sessions/:id/complete', async () => {
		const sessionId = 'test-session-abc'
		const result = await runBash(
			`
				source "${AGENT_RUN_SH}"
				set +e
				AGENT_EXIT_CODE=99
				detect_disk_full() { return 0; }
				AGENT_SERVER_URL="${serverUrl}"
				SESSION_ID="${sessionId}"
				on_exit
			`,
		)
		expect(result.code).toBe(0)
		expect(receivedBody).not.toBeNull()
		expect(receivedBody).toBe('{"exitCode":28}')
	})

	it('POSTs the original code when there is no disk-full signal', async () => {
		const sessionId = 'test-session-xyz'
		const result = await runBash(
			`
				source "${AGENT_RUN_SH}"
				set +e
				AGENT_EXIT_CODE=42
				detect_disk_full() { return 1; }
				AGENT_SERVER_URL="${serverUrl}"
				SESSION_ID="${sessionId}"
				on_exit
			`,
		)
		expect(result.code).toBe(0)
		expect(receivedBody).toBe('{"exitCode":42}')
	})
})
