import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	assertValidSessionId,
	buildMsbCreateArgs,
	cleanupBrowserSidecar,
	ensureAgentServerSshKey,
	ensureSessionSkeleton,
	formatOverflowEnvFile,
	listSandboxNames,
	provisionBrowserSidecar,
	removeSandbox,
	resolvePreviewPortMappings,
	sanitizeEnvForMicroVM,
	spawnSession,
	startSshRelay,
	stopSandbox,
	waitForCompletion,
} from '../services/microsandbox'
import type { ProcessSpawner } from '../services/microsandbox'

function makePortAllocator(start: number): () => Promise<number> {
	let next = start
	return async () => next++
}

// Fake ProcessSpawner for startSshRelay/provisionBrowserSidecar tests — never
// launches a real OS process. Unlike msbBin (always a fake path in tests),
// sshBin often resolves to a real, installed `ssh` binary (explicit
// '/usr/bin/ssh', or the 'ssh' PATH default), so without this override these
// "unit" tests would spawn real ssh child processes.
function fakeSpawnProcess(): ProcessSpawner {
	return () => {
		const proc = new EventEmitter() as unknown as ChildProcess
		proc.unref = () => proc
		proc.kill = () => true
		return proc
	}
}

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

	it('adds no extra allow@host:tcp:<port> rules when extraAllowedHostPorts is omitted', () => {
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
		expect(netRules).toEqual([
			'allow@host:tcp:3001',
			'allow@public',
			'allow@any:udp:53',
			'allow@any:tcp:53',
		])
	})

	it('adds one allow@host:tcp:<port> net-rule per extraAllowedHostPorts entry (narrow SSH-relay grant)', () => {
		const args = buildMsbCreateArgs({
			sessionId: 's',
			image: 'i',
			memoryMib: 512,
			cpus: 1,
			hostPort: 3001,
			env: {},
			sessionDir: '/d',
			extraAllowedHostPorts: [39500, 39501],
		})
		const netRules: string[] = []
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] === '--net-rule') netRules.push(args[i + 1] as string)
		}
		expect(netRules).toContain('allow@host:tcp:39500')
		expect(netRules).toContain('allow@host:tcp:39501')
	})

	it('adds allow@private when allowPrivateNet is true (reach the browser sidecar on the msb bridge)', () => {
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

	it('omits allow@private when allowPrivateNet is false or omitted', () => {
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
})

describe('resolvePreviewPortMappings', () => {
	it('resolves one free host-loopback relay port per guest port', async () => {
		let next = 39500
		const findPort = async () => next++
		const result = await resolvePreviewPortMappings([5173, 3000], {
			msbBin: '/usr/local/bin/msb',
			run: async () => ({ stdout: '', stderr: '' }),
			findPort,
		})
		expect(result.mappings).toEqual([
			{ guestPort: 5173, relayPort: 39500 },
			{ guestPort: 3000, relayPort: 39501 },
		])
		expect(() => result.release()).not.toThrow()
	})

	it('returns an empty array for an empty guestPorts list', async () => {
		const result = await resolvePreviewPortMappings([], {
			msbBin: '/usr/local/bin/msb',
			run: async () => ({ stdout: '', stderr: '' }),
			findPort: async () => 39500,
		})
		expect(result.mappings).toEqual([])
		expect(() => result.release()).not.toThrow()
	})

	it('releases already-resolved reservations when a later guest port fails to resolve', async () => {
		let calls = 0
		const findPort = async () => {
			calls++
			if (calls === 2) throw new Error('no free ports')
			return 39500 + calls
		}
		await expect(
			resolvePreviewPortMappings([5173, 3000], {
				msbBin: '/usr/local/bin/msb',
				run: async () => ({ stdout: '', stderr: '' }),
				findPort,
			}),
		).rejects.toThrow('no free ports')
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

	it('threads extraAllowedHostPorts into the create call as extra allow@host:tcp net-rules', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-preview-'))
		try {
			const { run, calls } = makeRunner({
				create: { stdout: '' },
				list: { stdout: JSON.stringify([{ name: 'orch-preview', status: 'Running' }]) },
			})
			await spawnSession(
				{
					...baseInput,
					sessionId: 'orch-preview',
					sessionDir: dir,
					extraAllowedHostPorts: [39500, 39501],
				},
				{ msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			)
			const createCall = calls.find((c) => c.args[0] === 'create')
			expect(createCall?.args).toContain('allow@host:tcp:39500')
			expect(createCall?.args).toContain('allow@host:tcp:39501')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('threads allowPrivateNet into the create call as allow@private (reach the browser sidecar)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-private-'))
		try {
			const { run, calls } = makeRunner({
				create: { stdout: '' },
				list: { stdout: JSON.stringify([{ name: 'orch-private', status: 'Running' }]) },
			})
			await spawnSession(
				{
					...baseInput,
					sessionId: 'orch-private',
					sessionDir: dir,
					allowPrivateNet: true,
				},
				{ msbBin: '/usr/local/bin/msb', run, sleep: async () => {}, now: () => 0 },
			)
			const createCall = calls.find((c) => c.args[0] === 'create')
			expect(createCall?.args).toContain('allow@private')
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

describe('listSandboxNames', () => {
	const msbBin = '/usr/local/bin/msb'

	it('returns every sandbox name regardless of status', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: JSON.stringify([
				{ name: 'sess-1', status: 'Running' },
				{ name: 'sess-2', status: 'Stopped' },
				{ name: 'anko-browser-abc123', status: 'Running' },
			]),
			stderr: '',
		})
		const names = await listSandboxNames({ msbBin, run })
		expect(names).toEqual(['sess-1', 'sess-2', 'anko-browser-abc123'])
	})

	it('returns an empty array when msb reports no sandboxes', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => ({
			stdout: JSON.stringify([]),
			stderr: '',
		})
		const names = await listSandboxNames({ msbBin, run })
		expect(names).toEqual([])
	})

	it('propagates an error from a failing msb list call', async () => {
		const run = async (): Promise<{ stdout: string; stderr: string }> => {
			throw new Error('msb list failed')
		}
		await expect(listSandboxNames({ msbBin, run })).rejects.toThrow('msb list failed')
	})
})

describe('ensureAgentServerSshKey', () => {
	it('generates a keypair via ssh-keygen when absent, then authorizes it with msb', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-sshkey-'))
		try {
			const keyPath = join(dir, 'nested', 'relay_key')
			const calls: Array<{ bin: string; args: readonly string[] }> = []
			const run = async (
				bin: string,
				args: readonly string[],
			): Promise<{ stdout: string; stderr: string }> => {
				calls.push({ bin, args })
				return { stdout: '', stderr: '' }
			}
			const info = await ensureAgentServerSshKey(keyPath, {
				msbBin: '/usr/local/bin/msb',
				run,
				sshKeygenBin: '/usr/bin/ssh-keygen',
			})
			expect(info).toEqual({ privateKeyPath: keyPath, publicKeyPath: `${keyPath}.pub` })
			expect(calls[0]).toEqual({
				bin: '/usr/bin/ssh-keygen',
				args: ['-t', 'ed25519', '-N', '', '-f', keyPath],
			})
			expect(calls[1]).toEqual({
				bin: '/usr/local/bin/msb',
				args: ['ssh', 'authorize', '--file', `${keyPath}.pub`],
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('skips ssh-keygen but still re-authorizes when the key already exists', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maskin-msb-sshkey-'))
		try {
			const keyPath = join(dir, 'relay_key')
			await writeFile(keyPath, 'existing-key-material', { mode: 0o600 })
			const calls: Array<{ bin: string; args: readonly string[] }> = []
			const run = async (
				bin: string,
				args: readonly string[],
			): Promise<{ stdout: string; stderr: string }> => {
				calls.push({ bin, args })
				return { stdout: '', stderr: '' }
			}
			await ensureAgentServerSshKey(keyPath, {
				msbBin: '/usr/local/bin/msb',
				run,
				sshKeygenBin: '/usr/bin/ssh-keygen',
			})
			expect(calls.map((c) => c.bin)).toEqual(['/usr/local/bin/msb'])
			expect(calls[0]).toEqual({
				bin: '/usr/local/bin/msb',
				args: ['ssh', 'authorize', '--file', `${keyPath}.pub`],
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('startSshRelay', () => {
	const sshKeyPath = '/root/.agent-server/ssh/relay_key'

	it('opens a relay using a self-allocated port and returns relay info', async () => {
		const readyCalls: Array<{ host: string; port: number }> = []
		const relay = await startSshRelay('sess-relay1', 5173, sshKeyPath, {
			msbBin: '/usr/local/bin/msb',
			findPort: makePortAllocator(40000),
			tcpPollReady: async (host: string, port: number) => {
				readyCalls.push({ host, port })
			},
			sshBin: '/usr/bin/ssh',
			spawnProcess: fakeSpawnProcess(),
		})
		expect(relay).not.toBeNull()
		expect(relay?.relayPort).toBe(40000)
		expect(relay?.targetName).toBe('sess-relay1')
		expect(relay?.targetGuestPort).toBe(5173)
		// sshPort (allocated second) is polled first (msb ssh serve), then relayPort
		// (allocated first) is polled once the ssh -L tunnel is up.
		expect(readyCalls.map((c) => c.port)).toEqual([40001, 40000])
		relay?.stop()
	})

	it('uses a caller-supplied relayPort without allocating a second one for it', async () => {
		const findPortCalls: string[] = []
		const findPort = async (host: string): Promise<number> => {
			findPortCalls.push(host)
			return 41000
		}
		const relay = await startSshRelay(
			'sess-relay2',
			3000,
			sshKeyPath,
			{
				msbBin: '/usr/local/bin/msb',
				findPort,
				tcpPollReady: async () => {},
				sshBin: '/usr/bin/ssh',
				spawnProcess: fakeSpawnProcess(),
			},
			{ relayPort: 39999 },
		)
		expect(relay?.relayPort).toBe(39999)
		// Only the ssh-serve port is self-allocated when relayPort is supplied.
		expect(findPortCalls.length).toBe(1)
		relay?.stop()
	})

	it('returns null when relay port allocation fails', async () => {
		const relay = await startSshRelay('sess-relay3', 3000, sshKeyPath, {
			msbBin: '/usr/local/bin/msb',
			findPort: async () => {
				throw new Error('no free ports')
			},
			tcpPollReady: async () => {},
			spawnProcess: fakeSpawnProcess(),
		})
		expect(relay).toBeNull()
	})

	it('returns null when the msb ssh serve listener never becomes ready', async () => {
		const relay = await startSshRelay('sess-relay4', 3000, sshKeyPath, {
			msbBin: '/usr/local/bin/msb',
			findPort: makePortAllocator(42000),
			tcpPollReady: async () => {
				throw new Error('not ready')
			},
			sshBin: '/usr/bin/ssh',
			spawnProcess: fakeSpawnProcess(),
		})
		expect(relay).toBeNull()
	})

	it('returns null when the ssh tunnel never becomes ready (serve was ready)', async () => {
		let call = 0
		const relay = await startSshRelay('sess-relay5', 3000, sshKeyPath, {
			msbBin: '/usr/local/bin/msb',
			findPort: makePortAllocator(43000),
			tcpPollReady: async () => {
				call++
				if (call === 1) return // msb ssh serve readiness
				throw new Error('tunnel not ready')
			},
			sshBin: '/usr/bin/ssh',
			spawnProcess: fakeSpawnProcess(),
		})
		expect(relay).toBeNull()
	})

	it('rejects an invalid target name before spawning anything', async () => {
		await expect(
			startSshRelay('../etc/passwd', 3000, sshKeyPath, {
				msbBin: '/usr/local/bin/msb',
				findPort: makePortAllocator(44000),
				tcpPollReady: async () => {},
				spawnProcess: fakeSpawnProcess(),
			}),
		).rejects.toThrow(/Invalid session id/)
	})
})

describe('provisionBrowserSidecar', () => {
	const msbBin = '/usr/local/bin/msb'

	it('creates the sidecar VM, waits for Running, launches exec, publishes CDP on the bridge, polls CDP, returns the URL', async () => {
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
			findPort: makePortAllocator(39222),
			cdpPollReady: async () => {},
		})
		expect(sidecar?.name).toBe('anko-browser-deadbeef')
		expect(sidecar?.cdpUrl).toBe('http://10.0.1.1:39222')
		const verbs = calls.map((c) => c[0])
		expect(verbs).toContain('create')
		expect(verbs).toContain('list')
		expect(verbs).not.toContain('inspect')
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall).toContain('-p')
		expect(createCall).toContain('10.0.1.1:39222:9222')
		expect(createCall?.at(-1)).toBe('browser-sidecar:latest')
	})

	it('releases the host-port reservation before invoking msb create, so msb can actually bind the published port', async () => {
		// Regression test for a real bug: provisionBrowserSidecar used to hold
		// its own port-reservation socket open across the whole `msb create`
		// call and only release it afterward. Since `run()` for `create` blocks
		// until msb create finishes — unlike startSshRelay's fire-and-forget
		// spawns — and `-p <gateway>:<port>:9222` requires msb to bind that same
		// port itself as part of that same call, the held-open reservation made
		// every real `msb create` fail with EADDRINUSE. A mocked run() that
		// never touches a real socket can't catch this, so this test uses the
		// REAL findFreeHostPort (no findPort override) and, inside the fake
		// run(), attempts a genuine OS-level bind on the exact host:port pulled
		// out of the '-p' arg — that bind only succeeds if the reservation was
		// actually released before run() was called.
		const bridgeGateway = '127.0.0.1'
		let probeBindSucceeded = false
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			if (args[0] === 'create') {
				const publishArg = args[args.indexOf('-p') + 1] as string
				const [host, portStr] = publishArg.split(':')
				const port = Number(portStr)
				await new Promise<void>((resolve, reject) => {
					const probe = createServer()
					probe.once('error', reject)
					probe.listen(port, host, () => {
						probeBindSucceeded = true
						probe.close(() => resolve())
					})
				})
				return { stdout: '', stderr: '' }
			}
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-bindtest', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}

		const sidecar = await provisionBrowserSidecar(
			'bindtest',
			{
				msbBin,
				run,
				sleep: async () => {},
				now: () => 0,
				cdpPollReady: async () => {},
				// No findPort override — exercises the real findFreeHostPort /
				// releaseHostPort reservation lifecycle this test is about.
			},
			{ bridgeGateway },
		)

		expect(probeBindSucceeded).toBe(true)
		expect(sidecar).not.toBeNull()
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
				findPort: makePortAllocator(39222),
				cdpPollReady: async () => {},
			},
			{ image: 'maskin/browser-sidecar:latest' },
		)

		expect(sidecar?.cdpUrl).toBe('http://10.0.1.1:39222')
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall?.at(-1)).toBe('maskin/browser-sidecar:latest')
	})

	it('uses a configured bridgeGateway when provided', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-gw00001', status: 'Running' }]),
					stderr: '',
				}
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
				findPort: makePortAllocator(40000),
				cdpPollReady: async () => {},
			},
			{ bridgeGateway: '10.0.2.1' },
		)

		expect(sidecar?.cdpUrl).toBe('http://10.0.2.1:40000')
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall).toContain('10.0.2.1:40000:9222')
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
			findPort: makePortAllocator(39222),
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
			findPort: makePortAllocator(39222),
			cdpPollReady: async () => {
				throw new Error('CDP not ready within timeout')
			},
		})
		expect(sidecar).toBeNull()
		expect(calls.map((c) => c[0])).toContain('remove')
	})

	it('returns null without touching msb when host port allocation fails', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			return { stdout: '', stderr: '' }
		}
		const sidecar = await provisionBrowserSidecar('noport01', {
			msbBin,
			run,
			findPort: async () => {
				throw new Error('no free ports')
			},
		})
		expect(sidecar).toBeNull()
		expect(calls).toEqual([])
	})

	it('adds no extra allow@host:tcp:<port> rules when extraAllowedHostPorts is omitted', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-noprv0001', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		await provisionBrowserSidecar('noprv0001', {
			msbBin,
			run,
			sleep: async () => {},
			now: () => 0,
			findPort: makePortAllocator(39222),
			cdpPollReady: async () => {},
		})
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall?.some((a) => a.startsWith('allow@host:tcp:'))).toBe(false)
	})

	it('adds one allow@host:tcp:<port> net-rule per extraAllowedHostPorts entry (reach a session preview relay)', async () => {
		const calls: Array<readonly string[]> = []
		const run = async (
			_bin: string,
			args: readonly string[],
		): Promise<{ stdout: string; stderr: string }> => {
			calls.push(args)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([{ name: 'anko-browser-prv00001', status: 'Running' }]),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		}
		await provisionBrowserSidecar(
			'prv00001',
			{
				msbBin,
				run,
				sleep: async () => {},
				now: () => 0,
				findPort: makePortAllocator(39222),
				cdpPollReady: async () => {},
			},
			{ extraAllowedHostPorts: [39500, 39501] },
		)
		const createCall = calls.find((c) => c[0] === 'create')
		expect(createCall).toContain('allow@host:tcp:39500')
		expect(createCall).toContain('allow@host:tcp:39501')
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
