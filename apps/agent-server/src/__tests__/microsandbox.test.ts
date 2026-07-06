import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	assertValidSessionId,
	buildMsbCreateArgs,
	cleanupBrowserSidecar,
	ensureSessionSkeleton,
	formatOverflowEnvFile,
	provisionBrowserSidecar,
	removeSandbox,
	sanitizeEnvForMicroVM,
	spawnSession,
	stopSandbox,
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
	it('includes --net-rule allow@host:tcp:<port> and allow@public (bet constraint #7, v0.5.4 fix)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 'sess-1',
			image: 'maskin/agent-base:latest',
			memoryMib: 1024,
			cpus: 2,
			hostPort: 3001,
			env: {},
			sessionDir: '/agent/sessions/sess-1',
		})
		// Collect all --net-rule values
		const netRules: string[] = []
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] === '--net-rule') netRules.push(args[i + 1] as string)
		}
		expect(netRules).toContain('allow@host:tcp:3001')
		expect(netRules).toContain('allow@public')
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

	it('adds --max-duration <value> as the persistent-VM backstop when provided', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
			maxDuration: '8h',
		})
		const idx = args.indexOf('--max-duration')
		expect(idx).toBeGreaterThan(-1)
		expect(args[idx + 1]).toBe('8h')
	})

	it.each([undefined, '0'])('omits --max-duration when maxDuration is %s', (maxDuration) => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
			...(maxDuration !== undefined && { maxDuration }),
		})
		expect(args).not.toContain('--max-duration')
	})

	it('omits allow@private by default (default firewall posture stays tight)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
		})
		const netRules: string[] = []
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] === '--net-rule') netRules.push(args[i + 1] as string)
		}
		expect(netRules).not.toContain('allow@private')
	})

	it('adds allow@private only when allowPrivateNet is true (sidecar reachability)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
			allowPrivateNet: true,
		})
		const netRules: string[] = []
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] === '--net-rule') netRules.push(args[i + 1] as string)
		}
		expect(netRules).toContain('allow@private')
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

describe('stopSandbox', () => {
	it('shells out msb stop <name> (graceful, so the /agent mount flushes)', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			return { stdout: '', stderr: '' }
		}
		await stopSandbox('sess-done', { msbBin: '/usr/local/bin/msb', run })
		expect(calls.length).toBe(1)
		expect(calls[0]).toEqual(['stop', 'sess-done'])
	})

	it('rejects an invalid sandbox name before shelling out', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: '',
			stderr: '',
		})
		await expect(
			stopSandbox('foo;rm -rf /', { msbBin: '/usr/local/bin/msb', run }),
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

describe('provisionBrowserSidecar', () => {
	const msbBin = '/usr/local/bin/msb'

	it('creates the sidecar VM, waits for Running, launches exec, polls CDP, returns the URL', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-deadbeef', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		const sidecar = await provisionBrowserSidecar('deadbeef', {
			msbBin,
			run,
			sleep: async () => {},
			now: () => 0,
			findPort: async () => 39222,
			cdpPollReady: async () => {},
		})
		expect(sidecar).toEqual({
			name: 'anko-browser-deadbeef',
			cdpUrl: 'http://10.0.1.1:39222',
		})
		const verbs = calls.map((c) => c[0])
		expect(verbs).toContain('create')
		expect(verbs).toContain('list')
		expect(verbs).not.toContain('inspect')
		// create args must include port forwarding and the default image.
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall).toContain('-p')
		expect(createCall).toContain('10.0.1.1:39222:9222')
		expect(createCall?.at(-1)).toBe('browser-sidecar:latest')
	})

	it('uses a configured sidecar image when provided', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-custom1', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}

		const sidecar = await provisionBrowserSidecar(
			'custom1',
			{
				msbBin,
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: async () => 39222,
				cdpPollReady: async () => {},
			},
			{ image: 'maskin/browser-sidecar:latest' },
		)

		expect(sidecar?.cdpUrl).toBe('http://10.0.1.1:39222')
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall?.at(-1)).toBe('maskin/browser-sidecar:latest')
	})

	it('uses a configured bridge gateway when provided', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list')
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-gw00001', status: 'Running' }]),
					stderr: '',
				}
			return { stdout: '', stderr: '' }
		}

		const sidecar = await provisionBrowserSidecar(
			'gw00001',
			{
				msbBin,
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: async () => 40000,
				cdpPollReady: async () => {},
			},
			{ bridgeGateway: '192.168.100.1' },
		)

		expect(sidecar?.cdpUrl).toBe('http://192.168.100.1:40000')
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall).toContain('192.168.100.1:40000:9222')
	})

	it('returns null and removes the half-built VM when msb create fails', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'create') {
				throw Object.assign(new Error('boom'), { stderr: 'libkrun: image pull failed' })
			}
			return { stdout: '', stderr: '' }
		}
		const sidecar = await provisionBrowserSidecar('failcre8', {
			msbBin,
			run,
			sleep: async () => {},
			now: () => 0,
			findPort: async () => 39222,
			cdpPollReady: async () => {},
		})
		expect(sidecar).toBeNull()
		expect(calls.map((c) => c[0])).toEqual(['create', 'remove'])
	})

	it('returns null and removes the VM when CDP polling times out', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-nocdp000', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		const sidecar = await provisionBrowserSidecar('nocdp000', {
			msbBin,
			run,
			sleep: async () => {},
			now: () => 0,
			findPort: async () => 39222,
			cdpPollReady: async () => {
				throw new Error('CDP not ready within timeout')
			},
		})
		expect(sidecar).toBeNull()
		expect(calls.map((c) => c[0])).toContain('remove')
	})
})

describe('cleanupBrowserSidecar', () => {
	const msbBin = '/usr/local/bin/msb'

	// Drive the SLA polling deterministically: a fake clock + sleep means the
	// 60s deadline is reached in zero wall-clock time, so tests are fast.
	function fakeClock(stepMs = 1_000): {
		sleep: (ms: number) => Promise<void>
		now: () => number
	} {
		let t = 0
		return {
			sleep: async (ms: number) => {
				t += ms
			},
			now: () => {
				const v = t
				t += stepMs
				return v
			},
		}
	}

	it('removes the sidecar VM via msb remove -f --quiet and confirms via msb list', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				// Sidecar already absent on the first list — happy path.
				return { stdout: '[]', stderr: '' }
			}
			return { stdout: '', stderr: '' }
		}
		const clock = fakeClock()
		await cleanupBrowserSidecar(
			{ name: 'anko-browser-feed', cdpUrl: 'http://10.0.0.5:9222' },
			{ msbBin, run, sleep: clock.sleep, now: clock.now },
		)
		expect(calls[0]).toEqual(['remove', '-f', '--quiet', 'anko-browser-feed'])
		expect(calls[1]?.[0]).toBe('list')
	})

	it('no-ops when no sidecar was provisioned (the common path)', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			return { stdout: '', stderr: '' }
		}
		await cleanupBrowserSidecar(null, { msbBin, run })
		expect(calls.length).toBe(0)
	})

	it('swallows msb remove failures so a missing/stopped sandbox is idempotent', async () => {
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'remove') throw new Error('No such sandbox')
			// Confirm absence via msb list returning an empty roster.
			return { stdout: '[]', stderr: '' }
		}
		const clock = fakeClock()
		await expect(
			cleanupBrowserSidecar(
				{ name: 'anko-browser-gone', cdpUrl: 'http://10.0.0.6:9222' },
				{ msbBin, run, sleep: clock.sleep, now: clock.now },
			),
		).resolves.toBeUndefined()
	})

	it('polls msb list until the sidecar is absent — AC-T5 VM-count delta within 60s', async () => {
		// Simulate a slow agentd: list reports the sidecar for two polls, then it
		// drops out. The test asserts we keep polling and finish before the SLA.
		let listCalls = 0
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'list') {
				listCalls += 1
				const present = listCalls < 3
				return {
					stdout: JSON.stringify(
						present ? [{ name: 'anko-browser-slow', status: 'Stopping' }] : [],
					),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		const clock = fakeClock()
		await cleanupBrowserSidecar(
			{ name: 'anko-browser-slow', cdpUrl: 'http://10.0.0.7:9222' },
			{ msbBin, run, sleep: clock.sleep, now: clock.now },
		)
		expect(listCalls).toBeGreaterThanOrEqual(3)
	})

	it('logs an error when the sidecar is still present after the 60s SLA', async () => {
		// list never drops the sidecar — the function must exit (not hang) and
		// the surrounding monitorSession code must not be blocked indefinitely.
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-stuck', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		// Tick the fake clock by 30s per `now()` read so the deadline is hit fast.
		const clock = fakeClock(30_000)
		await expect(
			cleanupBrowserSidecar(
				{ name: 'anko-browser-stuck', cdpUrl: 'http://10.0.0.8:9222' },
				{ msbBin, run, sleep: clock.sleep, now: clock.now },
			),
		).resolves.toBeUndefined()
	})
})
