import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	assertValidSessionId,
	buildMsbCreateArgs,
	ensureSessionSkeleton,
	formatOverflowEnvFile,
	removeSandbox,
	sanitizeEnvForMicroVM,
	spawnSession,
	waitForCompletion,
} from '../services/microsandbox'

describe('assertValidSessionId', () => {
	it.each(['sess-123', 'a', 'Z9_-aB', 'a'.repeat(128)])('accepts %s', (id) => {
		expect(() => assertValidSessionId(id)).not.toThrow()
	})

	it.each([
		'',
		'-leading-dash',
		'has space',
		'has/slash',
		'../etc/passwd',
		'$(whoami)',
		'foo;rm -rf /',
		'a'.repeat(129),
	])('rejects %s', (id) => {
		expect(() => assertValidSessionId(id)).toThrow(/Invalid session id/)
	})
})

describe('sanitizeEnvForMicroVM', () => {
	it('strips non-printable ASCII (bet constraint #1)', () => {
		const { inline, overflow, sanitizedCount } = sanitizeEnvForMicroVM({
			NORWEGIAN: 'pølse-æøå',
			ASCII: 'plain',
		})
		expect(inline.NORWEGIAN).toBe('plse-')
		expect(inline.ASCII).toBe('plain')
		expect(sanitizedCount).toBe(1)
		expect(overflow).toEqual([])
	})

	it('spills values over the 1500-char threshold (bet constraint #2)', () => {
		const big = 'a'.repeat(1600)
		const { inline, overflow } = sanitizeEnvForMicroVM({
			SMALL: 'ok',
			HUGE: big,
		})
		expect(inline).toEqual({ SMALL: 'ok' })
		expect(overflow).toEqual([{ key: 'HUGE', value: big }])
	})

	it('counts sanitization once per value, regardless of how many bytes were stripped', () => {
		const { sanitizedCount } = sanitizeEnvForMicroVM({ X: 'æøåæøå' })
		expect(sanitizedCount).toBe(1)
	})

	it('throws on an invalid env var key (shell injection guard)', () => {
		expect(() => sanitizeEnvForMicroVM({ 'FOO=BAR': 'v' })).toThrow(/Invalid env var key/)
		expect(() => sanitizeEnvForMicroVM({ 'A;rm -rf /': 'v' })).toThrow(/Invalid env var key/)
		expect(() => sanitizeEnvForMicroVM({ '1STARTS_WITH_DIGIT': 'v' })).toThrow(
			/Invalid env var key/,
		)
	})
})

describe('formatOverflowEnvFile', () => {
	it('produces bash export lines with single quotes escaped', () => {
		const out = formatOverflowEnvFile([
			{ key: 'A', value: 'simple' },
			{ key: 'B', value: "with 'quote'" },
		])
		expect(out).toBe("export A='simple'\nexport B='with '\\''quote'\\'''\n")
	})

	it('ends with a trailing newline so source-ing concatenates cleanly', () => {
		expect(formatOverflowEnvFile([{ key: 'A', value: 'x' }]).endsWith('\n')).toBe(true)
	})
})

describe('ensureSessionSkeleton', () => {
	it('creates the four agent-harness subdirs (bet constraint #3)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-skel-'))
		try {
			await ensureSessionSkeleton(dir)
			for (const sub of ['workspace', 'skills', 'learnings', 'memory']) {
				const s = await stat(join(dir, sub))
				expect(s.isDirectory()).toBe(true)
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('buildMsbCreateArgs', () => {
	it('includes --net-rule allow@host:tcp:<port> (bet constraint #7, v0.5.4 fix)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 'sess-1',
			image: 'maskin/agent-base:latest',
			memoryMib: 1024,
			cpus: 2,
			hostPort: 3001,
			env: {},
			sessionDir: '/agent/sessions/sess-1',
		})
		expect(args).toContain('--net-rule')
		const idx = args.indexOf('--net-rule')
		expect(args[idx + 1]).toBe('allow@host:tcp:3001')
	})

	it('bind-mounts sessionDir at /agent', () => {
		const args = buildMsbCreateArgs({
			sessionId: 'sess-2',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/agent/sessions/sess-2',
		})
		const vIdx = args.indexOf('-v')
		expect(vIdx).toBeGreaterThan(-1)
		expect(args[vIdx + 1]).toBe('/agent/sessions/sess-2:/agent')
	})

	it('passes inline env as repeated -e key=value', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: { FOO: 'bar', BAZ: 'qux' },
			sessionDir: '/d',
		})
		const eIndices = args.map((a, i) => (a === '-e' ? i : -1)).filter((i) => i >= 0)
		expect(eIndices.length).toBe(2)
		const values = eIndices.map((i) => args[i + 1])
		expect(values).toContain('FOO=bar')
		expect(values).toContain('BAZ=qux')
	})

	it('puts the image argument last so msb does not parse it as a flag', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'alpine:3.20',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
		})
		expect(args.at(-1)).toBe('alpine:3.20')
	})

	it("defaults --pull to 'always' when no pullPolicy is provided", () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
		})
		const idx = args.indexOf('--pull')
		expect(idx).toBeGreaterThan(-1)
		expect(args[idx + 1]).toBe('always')
	})

	it("respects pullPolicy='missing' (warmer hits use this)", () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
			pullPolicy: 'if-missing',
		})
		const idx = args.indexOf('--pull')
		expect(args[idx + 1]).toBe('if-missing')
	})
})

describe('removeSandbox', () => {
	it('shells out msb remove -f --quiet <name>', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			return { stdout: '', stderr: '' }
		}
		await removeSandbox('image-warmer-abc', { msbBin: '/usr/local/bin/msb', run })
		expect(calls.length).toBe(1)
		expect(calls[0]).toEqual(['remove', '-f', '--quiet', 'image-warmer-abc'])
	})

	it('rejects an invalid sandbox name before shelling out', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: '',
			stderr: '',
		})
		await expect(
			removeSandbox('../etc/passwd', { msbBin: '/usr/local/bin/msb', run }),
		).rejects.toThrow(/Invalid session id/)
	})
})

describe('spawnSession (orchestration)', () => {
	const baseInput = {
		sessionId: 'orch-1',
		image: 'alpine:3.20',
		env: { OK: 'value' },
		hostPort: 3001,
	}

	function makeRunner(
		reply: Record<string, { stdout?: string; stderr?: string; throwError?: Error }>,
	) {
		const calls: Array<{ bin: string; args: readonly string[] }> = []
		const run = async (
			bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push({ bin, args })
			const verb = args[0] ?? ''
			const r = reply[verb]
			if (!r) return { stdout: '', stderr: '' }
			if (r.throwError) throw r.throwError
			return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
		}
		return { run, calls }
	}

	it('spawns end-to-end and returns connection info on the host port', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-spawn-'))
		try {
			const { run, calls } = makeRunner({
				create: { stdout: '' },
				list: { stdout: JSON.stringify([{ name: 'orch-1', status: 'Running' }]) },
			})
			const result = await spawnSession(
				{ ...baseInput, sessionDir: dir, publicHost: 'agent.example.com' },
				{ msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			)
			expect(result.sandboxName).toBe('orch-1')
			expect(result.connection).toEqual({ host: 'agent.example.com', port: 3001 })
			expect(calls[0]?.args[0]).toBe('create')
			expect(calls.at(-1)?.args[0]).toBe('list')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('writes .env-overflow.sh inside sessionDir when a value exceeds 1500 chars', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-overflow-'))
		try {
			const { run } = makeRunner({
				create: { stdout: '' },
				list: { stdout: JSON.stringify([{ name: 'orch-2', status: 'Running' }]) },
			})
			const big = 'b'.repeat(1600)
			const result = await spawnSession(
				{
					...baseInput,
					sessionId: 'orch-2',
					env: { SMALL: 'ok', HUGE: big },
					sessionDir: dir,
				},
				{ msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			)
			expect(result.envOverflowSpilled).toBe(1)
			const spilled = await readFile(join(dir, '.env-overflow.sh'), 'utf8')
			expect(spilled).toContain("export HUGE='")
			expect(spilled).toContain(big)
			expect(spilled).not.toContain('SMALL')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('throws and best-effort removes the sandbox when msb create fails', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-create-fail-'))
		try {
			const createErr = Object.assign(new Error('boom'), {
				stderr: 'libkrun: handshake failed',
			})
			const { run, calls } = makeRunner({
				create: { throwError: createErr },
				remove: { stdout: '' },
			})
			await expect(
				spawnSession(
					{ ...baseInput, sessionId: 'orch-3', sessionDir: dir },
					{ msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
				),
			).rejects.toThrow(/msb create failed/)
			expect(calls.map((c) => c.args[0])).toEqual(['create', 'remove'])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('throws and best-effort removes the sandbox when the polling deadline expires', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-stuck-'))
		try {
			const { run, calls } = makeRunner({
				create: { stdout: '' },
				list: { stdout: JSON.stringify([{ name: 'orch-4', status: 'Starting' }]) },
				remove: { stdout: '' },
			})
			let t = 0
			await expect(
				spawnSession(
					{ ...baseInput, sessionId: 'orch-4', sessionDir: dir },
					{
						msbBin: '/usr/local/bin/msb',
						run,
						sleep: async () => {
							t += 30_000
						},
						now: () => t,
					},
				),
			).rejects.toThrow(/did not reach Running/)
			expect(calls.map((c) => c.args[0])).toContain('remove')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('rejects invalid session ids before touching the filesystem', async () => {
		await expect(
			spawnSession(
				{ ...baseInput, sessionId: '../etc/passwd', sessionDir: '/tmp/should-not-be-created' },
				{
					msbBin: '/usr/local/bin/msb',
					run: async () => ({ stdout: '', stderr: '' }),
					sleep: async () => {},
					now: () => 0,
				},
			),
		).rejects.toThrow(/Invalid session id/)
	})
})

describe('waitForCompletion', () => {
	const msbBin = '/usr/local/bin/msb'

	it('resolves immediately when the sandbox is no longer in the list', async () => {
		const calls: string[][] = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push([...args])
			return { stdout: JSON.stringify([]), stderr: '' }
		}
		let t = 0
		await waitForCompletion(
			msbBin,
			'sess-done',
			{
				run,
				sleep: async () => {
					t += 5_000
				},
				now: () => t,
			},
			60_000,
		)
		expect(calls.length).toBe(1)
	})

	it('keeps polling while the sandbox is Running, resolves when it disappears', async () => {
		let pollCount = 0
		const run = async (
			_bin: string,
			_args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			pollCount++
			// Running for first two polls, gone on the third
			const list = pollCount < 3 ? [{ name: 'sess-1', status: 'Running' }] : []
			return { stdout: JSON.stringify(list), stderr: '' }
		}
		let t = 0
		await waitForCompletion(
			msbBin,
			'sess-1',
			{
				run,
				sleep: async () => {
					t += 5_000
				},
				now: () => t,
			},
			60_000,
		)
		expect(pollCount).toBe(3)
	})

	it('resolves when status changes to non-Running (e.g. Exited)', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: JSON.stringify([{ name: 'sess-2', status: 'Exited' }]),
			stderr: '',
		})
		let t = 0
		await waitForCompletion(
			msbBin,
			'sess-2',
			{
				run,
				sleep: async () => {
					t += 5_000
				},
				now: () => t,
			},
			60_000,
		)
		// Should not throw or hang
	})

	it('resolves (with a warning) when the timeout elapses without the sandbox exiting', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: JSON.stringify([{ name: 'stuck', status: 'Running' }]),
			stderr: '',
		})
		let t = 0
		// Advance time past the timeout on each sleep so the loop exits
		await waitForCompletion(
			msbBin,
			'stuck',
			{
				run,
				sleep: async () => {
					t += 10_000
				},
				now: () => t,
			},
			5_000,
		)
	})

	it('tolerates transient msb list errors without throwing', async () => {
		let calls = 0
		const run = async (): Promise<{ stdout: string; stderr: string }> => {
			calls++
			if (calls < 3) throw new Error('msb list failed')
			return { stdout: JSON.stringify([]), stderr: '' }
		}
		let t = 0
		await waitForCompletion(
			msbBin,
			'sess-3',
			{
				run,
				sleep: async () => {
					t += 5_000
				},
				now: () => t,
			},
			60_000,
		)
		expect(calls).toBe(3)
	})
})
