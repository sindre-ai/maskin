import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Repo root, four levels up from this test file (apps/dev/src/__tests__/scripts).
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'gh-pr-merge-auto.sh')

interface StubOptions {
	// stdout/stderr per attempt, indexed by attempt number (1-based via GH_STUB_STATE).
	attempts: Array<{ stderr: string; exit: number }>
}

function writeGhStub(dir: string, options: StubOptions): { bin: string; log: string } {
	const bin = join(dir, 'gh')
	const log = join(dir, 'gh-calls.log')
	const state = join(dir, 'gh-attempt')
	writeFileSync(state, '0')
	const branches = options.attempts
		.map((a, idx) => `  ${idx + 1}) printf '%s' ${JSON.stringify(a.stderr)} >&2; exit ${a.exit} ;;`)
		.join('\n')
	const script = `#!/usr/bin/env bash
set -uo pipefail
STATE_FILE="${state}"
n=$(cat "$STATE_FILE")
n=$((n + 1))
printf '%s\\n' "$n $*" >> "${log}"
echo "$n" > "$STATE_FILE"
case "$n" in
${branches}
  *) echo "gh stub: unexpected attempt $n" >&2; exit 99 ;;
esac
`
	writeFileSync(bin, script)
	chmodSync(bin, 0o755)
	return { bin, log }
}

function runWrapper(ghBin: string, args: string[]): { status: number; stderr: string } {
	const result = spawnSync('bash', [SCRIPT, ...args], {
		env: {
			...process.env,
			GH_BIN: ghBin,
			GH_MERGE_RETRY_DELAY: '0',
			PATH: process.env.PATH ?? '',
		},
		encoding: 'utf8',
	})
	return { status: result.status ?? -1, stderr: result.stderr ?? '' }
}

describe('gh-pr-merge-auto.sh', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'gh-merge-'))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it('succeeds on the first attempt when gh exits 0', () => {
		const { bin, log } = writeGhStub(dir, {
			attempts: [{ stderr: '', exit: 0 }],
		})
		const { status } = runWrapper(bin, ['1234'])
		expect(status).toBe(0)
		const calls = readFile(log)
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatch(/pr merge 1234 --auto --squash/)
	})

	it('retries once on a transient 5xx and succeeds on the second attempt', () => {
		const { bin, log } = writeGhStub(dir, {
			attempts: [
				{ stderr: 'HTTP 503: Service Unavailable\n', exit: 1 },
				{ stderr: '', exit: 0 },
			],
		})
		const { status, stderr } = runWrapper(bin, ['https://github.com/o/r/pull/42'])
		expect(status).toBe(0)
		expect(stderr).toMatch(/transient 5xx on first attempt/)
		expect(readFile(log)).toHaveLength(2)
	})

	it('returns the second failure verbatim when both attempts hit 5xx', () => {
		const { bin, log } = writeGhStub(dir, {
			attempts: [
				{ stderr: 'HTTP 502 Bad Gateway\n', exit: 1 },
				{ stderr: 'HTTP 502 Bad Gateway\n', exit: 1 },
			],
		})
		const { status, stderr } = runWrapper(bin, ['42'])
		expect(status).toBe(1)
		expect(stderr).toMatch(/HTTP 502 Bad Gateway/)
		expect(readFile(log)).toHaveLength(2)
	})

	it('does NOT retry a non-5xx failure — e.g. mergeable-blocked, 401, 403', () => {
		const cases: Array<{ stderr: string; exit: number }> = [
			{ stderr: 'Pull request is not mergeable: mergeable-blocked\n', exit: 1 },
			{ stderr: 'HTTP 401: Bad credentials\n', exit: 1 },
			{ stderr: 'HTTP 403: Resource not accessible by integration\n', exit: 1 },
			{
				stderr:
					'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)\n',
				exit: 1,
			},
		]
		for (const c of cases) {
			const { bin, log } = writeGhStub(dir, { attempts: [c] })
			const { status, stderr } = runWrapper(bin, ['42'])
			expect(status).toBe(c.exit)
			expect(stderr).toContain(c.stderr.trim())
			expect(readFile(log)).toHaveLength(1)
			// Clear the log for the next iteration.
			writeFileSync(log, '')
			writeFileSync(join(dir, 'gh-attempt'), '0')
		}
	})

	it('exits 2 when no PR argument is provided', () => {
		const { bin } = writeGhStub(dir, { attempts: [{ stderr: '', exit: 0 }] })
		const { status, stderr } = runWrapper(bin, [])
		expect(status).toBe(2)
		expect(stderr).toMatch(/usage:/)
	})

	it('forwards extra gh args after the PR', () => {
		const { bin, log } = writeGhStub(dir, {
			attempts: [{ stderr: '', exit: 0 }],
		})
		runWrapper(bin, ['42', '--repo', 'sindre-ai/maskin'])
		const calls = readFile(log)
		expect(calls[0]).toMatch(/pr merge 42 --auto --squash --repo sindre-ai\/maskin/)
	})
})

function readFile(path: string): string[] {
	const raw = require('node:fs').readFileSync(path, 'utf8') as string
	return raw.split('\n').filter((line: string) => line.length > 0)
}
