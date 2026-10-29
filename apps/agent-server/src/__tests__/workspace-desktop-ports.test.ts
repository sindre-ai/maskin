import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MicrosandboxDeps, ProcessSpawner } from '../services/microsandbox'
import { releaseHostPort } from '../services/microsandbox'
import { WorkspaceDesktopRegistry, desktopName } from '../services/workspace-desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const AGENT_A = '33333333-3333-4333-8333-333333333333'
const AGENT_B = '44444444-4444-4444-8444-444444444444'
const SESSION = 'sess-aaaa-1111'

// Real loopback ports are reserved by the code under test, so use a range no
// other test or dev server is likely to hold.
const PORT_START = 29100
const BLOCK = 3

const fetchImpl = (async (url: string | URL | Request) => {
	if (String(url).endsWith('/healthz')) return new Response('{"ready":true}', { status: 200 })
	return new Response('{}', { status: 200 })
}) as typeof fetch

function makeMsb() {
	const calls: string[][] = []
	const spawned: Array<{ bin: string; args: string[]; killed: boolean; stderr: EventEmitter }> = []
	const sandboxes = new Set<string>()
	// What `msb ssh serve --help` prints; older msb releases do not list the flag.
	const serveHelp = { text: 'Options:\n  --no-inactivity-timeout  Disable the SSH inactivity timeout' }
	const clock = { t: 1_000_000 }
	let nextPort = 43000
	const spawnProcess: ProcessSpawner = (bin, args) => {
		const rec = { bin, args: [...args], killed: false, stderr: new EventEmitter() }
		spawned.push(rec)
		const proc = new EventEmitter() as unknown as ChildProcess
		;(proc as { stderr: unknown }).stderr = rec.stderr
		proc.unref = () => proc
		proc.kill = () => {
			rec.killed = true
			return true
		}
		return proc
	}
	const msb: MicrosandboxDeps = {
		msbBin: '/fake/msb',
		run: async (_bin, args) => {
			calls.push([...args])
			const [cmd, sub] = args
			const nameArg = args[args.indexOf('--name') + 1] as string
			if (cmd === 'run' || cmd === 'create') sandboxes.add(nameArg)
			if (cmd === 'remove') sandboxes.delete(args[args.length - 1] as string)
			if (cmd === 'snapshot' && sub === 'create') {
				await writeFile(args[args.indexOf('-o') + 1] as string, 'snapshot-bytes')
			}
			if (cmd === 'snapshot' && sub === 'restore') sandboxes.add(nameArg)
			if (cmd === 'ssh' && sub === 'serve') return { stdout: serveHelp.text, stderr: '' }
			if (cmd === 'list') {
				return {
					stdout: JSON.stringify([...sandboxes].map((name) => ({ name, status: 'Running' }))),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		},
		sleep: async () => {},
		now: () => clock.t,
		findPort: async () => nextPort++,
		tcpPollReady: async () => {},
		spawnProcess,
	}
	return { msb, calls, spawned, sandboxes, clock, serveHelp }
}

describe('WorkspaceDesktopRegistry port exposure', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'desktop-ports-'))
	})
	afterEach(async () => {
		for (let p = PORT_START; p < PORT_START + 4 * BLOCK; p++) releaseHostPort(p)
		await rm(dir, { recursive: true, force: true })
	})

	function makeRegistry(
		msb: MicrosandboxDeps,
		opts: { relay?: boolean; snapshots?: boolean } = {},
	) {
		return new WorkspaceDesktopRegistry({
			msb,
			image: 'd',
			stateFile: join(dir, 'state', 'desktops.json'),
			fetchImpl,
			...(opts.snapshots && { snapshots: { dir: join(dir, 'snaps'), idleSuspendMs: 60_000 } }),
			...(opts.relay !== false && {
				relay: {
					portStart: PORT_START,
					portEnd: PORT_START + 4 * BLOCK - 1,
					blockSize: BLOCK,
					sshKeyPath: '/keys/relay_key',
				},
			}),
		})
	}

	const rulesOf = (args: string[]): string[] =>
		args.flatMap((a, i) => (args[i - 1] === '--net-rule' ? [a] : []))

	it('gives each computer its own block and allows only that block, never allow@private', async () => {
		const { msb, calls } = makeMsb()
		const registry = makeRegistry(msb)

		await registry.ensure(WS, AGENT_A)
		await registry.ensure(WS, AGENT_B)

		const creates = calls.filter((c) => c[0] === 'create')
		expect(registry.get(WS, AGENT_A)?.relayBlockStart).toBe(PORT_START)
		expect(registry.get(WS, AGENT_B)?.relayBlockStart).toBe(PORT_START + BLOCK)
		const rulesA = rulesOf(creates[0] as string[])
		const rulesB = rulesOf(creates[1] as string[])
		expect(rulesA).toContain(`allow@host:tcp:${PORT_START}-${PORT_START + BLOCK - 1}`)
		expect(rulesB).toContain(`allow@host:tcp:${PORT_START + BLOCK}-${PORT_START + 2 * BLOCK - 1}`)
		for (const rules of [rulesA, rulesB]) {
			expect(rules).not.toContain('allow@private')
			// first match wins: the IPv6 host-alias deny must come before the allow
			expect(rules.indexOf('deny@[fd42:6d73:62::/48]')).toBeLessThan(
				rules.findIndex((r) => r.startsWith('allow@host:tcp:')),
			)
		}
	})

	it('adds no host rule when relays are not configured', async () => {
		const { msb, calls } = makeMsb()
		await makeRegistry(msb, { relay: false }).ensure(WS, AGENT_A)

		const create = calls.find((c) => c[0] === 'create') as string[]
		expect(rulesOf(create).some((r) => r.startsWith('allow@host:'))).toBe(false)
	})

	it('gives a new computer no block once the pool is used up, and still provisions it', async () => {
		const { msb } = makeMsb()
		const registry = makeRegistry(msb)
		for (const n of [1, 2, 3, 4]) {
			await registry.ensure(WS, `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`)
		}

		const fifth = await registry.ensure(WS, AGENT_A)

		expect(fifth).not.toBeNull()
		expect(fifth?.relayBlockStart).toBeUndefined()
		const result = await registry.exposePort(WS, AGENT_A, SESSION, 5173)
		expect(result).toMatchObject({ ok: false, reason: 'no_relay_block' })
	})

	it('opens a tunnel from a port in the computer’s own block and returns that port', async () => {
		const { msb, spawned } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_B)

		const result = await registry.exposePort(WS, AGENT_B, SESSION, 5173)

		expect(result).toEqual({
			ok: true,
			port: { guestPort: 5173, relayPort: PORT_START, sessionId: SESSION },
		})
		const serve = spawned.find((p) => p.args[0] === 'ssh' && p.args[1] === 'serve')
		expect(serve?.args[2]).toBe(SESSION)
		expect(serve?.args).toContain('--no-inactivity-timeout')
		const tunnel = spawned.find((p) => p.bin === 'ssh')
		expect(tunnel?.args).toContain(`127.0.0.1:${PORT_START}:127.0.0.1:5173`)
		expect(tunnel?.args).toContain('/keys/relay_key')
	})

	it('opens the tunnel without the idle-timeout flag when this msb does not have it', async () => {
		const { msb, spawned, serveHelp } = makeMsb()
		serveHelp.text = 'Usage: msb ssh serve --host <HOST> --port <PORT> <SANDBOX>'
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const result = await registry.exposePort(WS, AGENT_A, SESSION, 5173)

		expect(result).toMatchObject({ ok: true })
		const serve = spawned.find((p) => p.args[0] === 'ssh' && p.args[1] === 'serve')
		expect(serve?.args).not.toContain('--no-inactivity-timeout')
	})

	it('is idempotent per session and port, and hands out the next port for a different one', async () => {
		const { msb, spawned } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const first = await registry.exposePort(WS, AGENT_A, SESSION, 5173)
		const again = await registry.exposePort(WS, AGENT_A, SESSION, 5173)
		const other = await registry.exposePort(WS, AGENT_A, SESSION, 3000)

		expect(again).toEqual(first)
		expect(other).toMatchObject({ ok: true, port: { relayPort: PORT_START + 1 } })
		expect(spawned.filter((p) => p.bin === 'ssh')).toHaveLength(2)
	})

	it('serialises concurrent exposes so two never share a port', async () => {
		const { msb } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const results = await Promise.all([
			registry.exposePort(WS, AGENT_A, SESSION, 5173),
			registry.exposePort(WS, AGENT_A, SESSION, 3000),
			registry.exposePort(WS, AGENT_A, SESSION, 8080),
		])

		const ports = results.map((r) => (r.ok ? r.port.relayPort : -1))
		expect(new Set(ports).size).toBe(3)
		expect(ports.every((p) => p >= PORT_START && p < PORT_START + BLOCK)).toBe(true)
	})

	it('refuses beyond the block size with a message the agent can act on', async () => {
		const { msb } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)
		for (const p of [3000, 3001, 3002]) await registry.exposePort(WS, AGENT_A, SESSION, p)

		const result = await registry.exposePort(WS, AGENT_A, SESSION, 3003)

		expect(result).toMatchObject({ ok: false, reason: 'too_many_ports' })
		expect(result.ok ? '' : result.message).toMatch(/Close one first/)
	})

	it('frees a slot when a port is closed, and stops its processes', async () => {
		const { msb, spawned } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)
		for (const p of [3000, 3001, 3002]) await registry.exposePort(WS, AGENT_A, SESSION, p)

		expect(registry.closePort(WS, AGENT_A, PORT_START)).toBe(true)
		expect(registry.closePort(WS, AGENT_A, PORT_START)).toBe(false)

		expect(spawned.filter((p) => p.killed)).toHaveLength(2)
		const reused = await registry.exposePort(WS, AGENT_A, SESSION, 4000)
		expect(reused).toMatchObject({ ok: true, port: { relayPort: PORT_START } })
		expect(
			registry
				.listPorts(WS, AGENT_A)
				.map((p) => p.guestPort)
				.sort(),
		).toEqual([3001, 3002, 4000])
	})

	it('closes every tunnel into a session when it ends, and only that session’s', async () => {
		const { msb } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)
		await registry.exposePort(WS, AGENT_A, SESSION, 5173)
		await registry.exposePort(WS, AGENT_A, 'sess-bbbb-2222', 5173)

		registry.closeSessionRelays(SESSION)

		expect(registry.listPorts(WS, AGENT_A)).toEqual([
			{ guestPort: 5173, relayPort: PORT_START + 1, sessionId: 'sess-bbbb-2222' },
		])
	})

	it('reports failure when the tunnel cannot be opened, and releases the port', async () => {
		const { msb } = makeMsb()
		msb.tcpPollReady = async () => {
			throw new Error('never ready')
		}
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const result = await registry.exposePort(WS, AGENT_A, SESSION, 5173)

		expect(result).toMatchObject({ ok: false, reason: 'relay_failed' })
		expect(registry.listPorts(WS, AGENT_A)).toEqual([])
		// the failed attempt must not leave the port held
		expect(await registry.exposePort(WS, AGENT_A, SESSION, 5173)).toMatchObject({
			ok: false,
			reason: 'relay_failed',
		})
	})

	it('says why the tunnel failed, with what ssh reported', async () => {
		const { msb, spawned, sandboxes } = makeMsb()
		sandboxes.add(SESSION)
		msb.tcpPollReady = async (_host, port) => {
			// the first poll is msb ssh serve and passes; the second is the ssh tunnel
			if (port !== PORT_START) return
			const tunnel = spawned.find((p) => p.bin !== '/fake/msb')
			tunnel?.stderr.emit(
				'data',
				Buffer.from('Load key "/home/msb/.ssh/relay_key": Permission denied (publickey).\n'),
			)
			throw new Error('never ready')
		}
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const result = await registry.exposePort(WS, AGENT_A, SESSION, 5173)

		expect(result).toMatchObject({ ok: false, reason: 'relay_failed' })
		if (result.ok) throw new Error('expected a failure')
		expect(result.message).toContain('ssh could not forward port 5173')
		expect(result.message).toContain('Permission denied (publickey)')
		// host paths stay out of what the agent sees
		expect(result.message).not.toContain('/home/msb')
		expect(result.message).toContain('Session sandbox: running.')
	})

	it('says when the session sandbox is already gone', async () => {
		const { msb } = makeMsb()
		msb.tcpPollReady = async () => {
			throw new Error('never ready')
		}
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)

		const result = await registry.exposePort(WS, AGENT_A, SESSION, 5173)

		if (result.ok) throw new Error('expected a failure')
		expect(result.message).toContain('Session sandbox: missing.')
	})

	it('refuses when the agent has no computer', async () => {
		const { msb } = makeMsb()
		const result = await makeRegistry(msb).exposePort(WS, AGENT_A, SESSION, 5173)
		expect(result).toMatchObject({ ok: false, reason: 'no_desktop' })
	})

	it('removing the computer stops its tunnels', async () => {
		const { msb, spawned } = makeMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS, AGENT_A)
		await registry.exposePort(WS, AGENT_A, SESSION, 5173)

		await registry.remove(WS, AGENT_A)

		const tunnelProcs = spawned.filter((p) => p.bin === 'ssh' || p.args[0] === 'ssh')
		expect(tunnelProcs).toHaveLength(2)
		expect(tunnelProcs.every((p) => p.killed)).toBe(true)
		expect(registry.listPorts(WS, AGENT_A)).toEqual([])
	})

	it('keeps its block across a restart', async () => {
		const first = makeMsb()
		await makeRegistry(first.msb).ensure(WS, AGENT_B)
		const second = makeRegistry(first.msb)

		await second.reconcile([desktopName(WS, AGENT_B)])

		expect(second.get(WS, AGENT_B)?.relayBlockStart).toBe(PORT_START)
	})

	describe('after a suspend and wake', () => {
		it('restores with the full firewall, so the computer can still reach its own block', async () => {
			const { msb, calls, clock } = makeMsb()
			const registry = makeRegistry(msb, { snapshots: true })
			await registry.ensure(WS, AGENT_A)
			clock.t += 60_000
			expect(await registry.suspend(WS, AGENT_A)).toBe(true)

			await registry.ensure(WS, AGENT_A)

			const restore = calls.find((c) => c[0] === 'snapshot' && c[1] === 'restore') as string[]
			const rules = rulesOf(restore)
			expect(restore[restore.indexOf('--net-default') + 1]).toBe('deny')
			// ingress stays open so the published noVNC and control ports keep working
			expect(rules).toContain('allow:ingress@any')
			expect(rules).toContain(`allow:egress@host:tcp:${PORT_START}-${PORT_START + BLOCK - 1}`)
			expect(rules).toContain('allow:egress@public')
			expect(rules).not.toContain('allow@private')
			expect(rules.some((r) => r.includes('allow:egress@private'))).toBe(false)
		})
	})
})
