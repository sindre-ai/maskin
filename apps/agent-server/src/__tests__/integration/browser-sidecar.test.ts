import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	buildMsbCreateArgs,
	removeSandbox,
	spawnSession,
	stopSandbox,
} from '../../services/microsandbox'

const msbBin = '/usr/local/bin/msb'

type RunCall = { bin: string; args: readonly string[]; timeoutMs?: number }

function captureRunner(responses: Array<{ stdout?: string; stderr?: string }> = []) {
	const calls: RunCall[] = []
	let i = 0
	const run = async (
		bin: string,
		args: readonly string[],
		options?: { timeoutMs?: number },
	): Promise<{ stdout: string; stderr: string }> => {
		calls.push({
			bin,
			args: [...args],
			...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		})
		const res = responses[i++] ?? {}
		return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
	}
	return { calls, run }
}

// The four ACs covered here are the microsandbox half of the bet's matrix.
// AC-T2 (Vercel-bypass-authenticated navigation) lives in apps/e2e because it
// requires a real Chromium driving real headers, and AC-T4 (end-to-end bet-qa
// posting) is exercised at the Acceptance Validator level in T8 against a
// seeded bet — neither is meaningful as a fully-mocked microsandbox test.

describe('AC-T1 (microsandbox leg): BROWSER_CDP_URL propagates through spawnSession', () => {
	it('passes BROWSER_CDP_URL into msb -e args when present in session env', async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), 'maskin-msb-browser-'))
		try {
			const cdpUrl = 'ws://192.168.123.45:9222'
			// First call: msb create. Second call: msb list (Running). Third: settle no-op.
			const { calls, run } = captureRunner([
				{ stdout: '', stderr: '' },
				{ stdout: JSON.stringify([{ name: 'sess-browser', status: 'Running' }]), stderr: '' },
			])
			await spawnSession(
				{
					sessionId: 'sess-browser',
					image: 'maskin/agent-base:latest',
					env: { BROWSER_CDP_URL: cdpUrl, MASKIN_API_URL: 'http://host:3000' },
					hostPort: 3001,
					sessionDir,
					pullPolicy: 'never',
				},
				{ msbBin, run, sleep: async () => {}, now: () => 0 },
			)
			const createArgs = calls.find((c) => c.args[0] === 'create')?.args ?? []
			expect(createArgs).toContain('-e')
			expect(createArgs.some((a) => a === `BROWSER_CDP_URL=${cdpUrl}`)).toBe(true)
		} finally {
			await rm(sessionDir, { recursive: true, force: true })
		}
	})

	it('does NOT include BROWSER_CDP_URL when the session env omits it (AC-T6 gating)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 'sess-no-browser',
			image: 'maskin/agent-base:latest',
			memoryMib: 1024,
			cpus: 1,
			hostPort: 3001,
			env: { MASKIN_API_URL: 'http://host:3000' },
			sessionDir: '/agent/sessions/sess-no-browser',
		})
		expect(args.some((a) => a.startsWith('BROWSER_CDP_URL='))).toBe(false)
	})
})

describe('AC-T5 (microsandbox leg): sidecar teardown completes well within the 60s SLA', () => {
	it('removeSandbox issues `msb remove -f --quiet <name>` with a 15s timeout', async () => {
		const { calls, run } = captureRunner([{ stdout: '', stderr: '' }])
		await removeSandbox('sess-teardown', { msbBin, run })
		const removeCall = calls.find((c) => c.args[0] === 'remove')
		expect(removeCall?.args).toEqual(['remove', '-f', '--quiet', 'sess-teardown'])
		expect(removeCall?.timeoutMs).toBeLessThanOrEqual(60_000)
	})

	it('stopSandbox issues a graceful stop within the 60s SLA', async () => {
		const { calls, run } = captureRunner([{ stdout: '', stderr: '' }])
		await stopSandbox('sess-stop', { msbBin, run })
		const stopCall = calls.find((c) => c.args[0] === 'stop')
		expect(stopCall?.args).toEqual(['stop', 'sess-stop'])
		expect(stopCall?.timeoutMs).toBeLessThanOrEqual(60_000)
	})
})
