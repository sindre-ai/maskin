import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MicrosandboxDeps, ProcessSpawner } from '../services/microsandbox'
import {
	DESKTOP_PREFIX,
	WorkspaceDesktopRegistry,
	desktopName,
	handleDesktopUpgrade,
} from '../services/workspace-desktop'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'
const AGENT_A = '33333333-3333-4333-8333-333333333333'
const AGENT_B = '44444444-4444-4444-8444-444444444444'
const SECRET = 'test-secret-thirty-two-chars-long'
const IDLE_MS = 10 * 60_000

// Stands in for desktopd: /healthz is always ready, every POST echoes its body.
const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
	if (String(url).endsWith('/healthz')) return new Response('{"ready":true}', { status: 200 })
	return new Response(
		JSON.stringify({ ok: true, echoed: JSON.parse(String(init?.body ?? '{}')) }),
		{
			status: 200,
		},
	)
}) as typeof fetch

// A fake msb that speaks the 0.7 snapshot commands. `snapshot create -o <file>`
// writes the archive for real (suspend renames it into place), `snapshot restore`
// brings the named sandbox back, and `now` is a clock the tests advance.
function makeSnapshotMsb(opts: { failSnapshot?: boolean; failRestore?: boolean } = {}) {
	const calls: string[][] = []
	const sandboxes = new Set<string>()
	const execs: string[][] = []
	const spawnProcess: ProcessSpawner = (_bin, args) => {
		execs.push([...args])
		const proc = new EventEmitter() as unknown as ChildProcess
		proc.unref = () => proc
		proc.kill = () => true
		return proc
	}
	const clock = { t: 1_000_000 }
	let nextPort = 42000
	const fail = (stderr: string) => Object.assign(new Error('boom'), { stderr })
	const msb: MicrosandboxDeps = {
		msbBin: '/fake/msb',
		run: async (_bin, args) => {
			calls.push([...args])
			const [cmd, sub] = args
			const nameArg = args[args.indexOf('--name') + 1] as string
			if (cmd === 'run' || cmd === 'create') sandboxes.add(nameArg)
			if (cmd === 'remove') sandboxes.delete(args[args.length - 1] as string)
			if (cmd === 'snapshot' && sub === 'create') {
				if (opts.failSnapshot) throw fail('cannot capture')
				await writeFile(args[args.indexOf('-o') + 1] as string, 'snapshot-bytes')
			}
			if (cmd === 'snapshot' && sub === 'restore') {
				if (opts.failRestore) throw fail('cannot restore')
				sandboxes.add(nameArg)
			}
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
		spawnProcess,
	}
	return { msb, calls, sandboxes, execs, clock }
}

describe('WorkspaceDesktopRegistry suspend and wake', () => {
	let dir: string
	let stateFile: string
	let snapDir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'desktop-snap-'))
		stateFile = join(dir, 'state', 'desktops.json')
		snapDir = join(dir, 'snapshots')
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	function makeRegistry(msb: MicrosandboxDeps, idleSuspendMs = IDLE_MS) {
		return new WorkspaceDesktopRegistry({
			msb,
			image: 'd',
			stateFile,
			fetchImpl,
			snapshots: { dir: snapDir, idleSuspendMs },
		})
	}
	const archiveFor = (ws: string, agent = AGENT_A) => join(snapDir, `${desktopName(ws, agent)}.msb`)
	const exists = (path: string) =>
		stat(path).then(
			() => true,
			() => false,
		)

	it('starts the desktop with `msb run -d`, not create + exec, so a full snapshot is allowed', async () => {
		const { msb, calls, execs } = makeSnapshotMsb()

		await makeRegistry(msb).ensure(WS_A, AGENT_A)

		expect(calls.some((c) => c[0] === 'create')).toBe(false)
		const run = calls.find((c) => c[0] === 'run') as string[]
		expect(run.slice(0, 2)).toEqual(['run', '-d'])
		// `msb exec` would make the entrypoint a managed job, which blocks `--full`.
		expect(execs).toEqual([])
	})

	it('suspends an idle desktop: full snapshot to an archive, then stops and removes the VM', async () => {
		const { msb, calls, sandboxes, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(true)

		const snap = calls.find((c) => c[0] === 'snapshot' && c[1] === 'create') as string[]
		expect(snap).toContain('--full')
		expect(snap[snap.indexOf('--sandbox') + 1]).toBe(desktopName(WS_A, AGENT_A))
		expect(calls.some((c) => c[0] === 'stop')).toBe(true)
		expect(sandboxes.size).toBe(0)
		expect(registry.get(WS_A, AGENT_A)?.status).toBe('suspended')
		expect(await exists(archiveFor(WS_A))).toBe(true)
		// No half-written archive is left behind.
		expect(await exists(join(snapDir, `${desktopName(WS_A, AGENT_A)}.partial.msb`))).toBe(false)
		expect(JSON.parse(await readFile(stateFile, 'utf8'))[`${WS_A}:${AGENT_A}`].status).toBe(
			'suspended',
		)
	})

	it('does not suspend a desktop that is not idle yet', async () => {
		const { msb, calls, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS - 1

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false)

		expect(calls.some((c) => c[0] === 'snapshot')).toBe(false)
		expect(registry.get(WS_A, AGENT_A)?.status).toBe('running')
	})

	it('does not suspend while a viewer is attached, and restarts the idle clock when it leaves', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		registry.viewerOpened(WS_A, AGENT_A)
		clock.t += IDLE_MS * 3

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false)

		registry.viewerClosed(WS_A, AGENT_A)
		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false) // idle clock restarted at close
		clock.t += IDLE_MS
		expect(await registry.suspend(WS_A, AGENT_A)).toBe(true)
	})

	it('counts an agent call as activity', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS - 1_000
		await registry.control(WS_A, AGENT_A, '/exec', { command: 'true' })
		clock.t += IDLE_MS - 1_000

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false)
	})

	it('sweepIdle suspends only the idle desktops', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		await registry.ensure(WS_B, AGENT_A)
		clock.t += IDLE_MS
		registry.touch(WS_B, AGENT_A)

		await registry.sweepIdle()

		expect(registry.get(WS_A, AGENT_A)?.status).toBe('suspended')
		expect(registry.get(WS_B, AGENT_A)?.status).toBe('running')
	})

	it('wakes a suspended desktop on ensure: restores the archive on the same ports and deletes it', async () => {
		const { msb, calls, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		const created = await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await registry.suspend(WS_A, AGENT_A)

		const woke = await registry.ensure(WS_A, AGENT_A)

		expect(woke).toBe(created)
		expect(woke?.status).toBe('running')
		const restore = calls.find((c) => c[0] === 'snapshot' && c[1] === 'restore') as string[]
		expect(restore[2]).toBe(archiveFor(WS_A))
		expect(restore[restore.indexOf('--name') + 1]).toBe(desktopName(WS_A, AGENT_A))
		const publishes = restore.flatMap((arg, i) => (arg === '-p' ? [restore[i + 1]] : []))
		expect(publishes).toEqual([
			`10.0.1.1:${created?.hostPort}:6080`,
			`10.0.1.1:${created?.controlPort}:6081`,
		])
		// Woken, not re-provisioned: same password, only the one `run`.
		expect(woke?.password).toBe(created?.password)
		expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
		expect(await exists(archiveFor(WS_A))).toBe(false)
		expect(JSON.parse(await readFile(stateFile, 'utf8'))[`${WS_A}:${AGENT_A}`].status).toBe(
			'running',
		)
	})

	it('wakes on a control call and forwards it', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await registry.suspend(WS_A, AGENT_A)

		const result = await registry.control(WS_A, AGENT_A, '/screenshot', {})

		expect(result?.status).toBe(200)
		expect(registry.get(WS_A, AGENT_A)?.status).toBe('running')
	})

	it('queues a wake behind a suspend that is already running, with one restore', async () => {
		const { msb, calls, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS

		const [suspended, a, b] = await Promise.all([
			registry.suspend(WS_A, AGENT_A),
			registry.ensure(WS_A, AGENT_A),
			registry.ensure(WS_A, AGENT_A),
		])

		expect(suspended).toBe(true)
		expect(a).toBe(b)
		expect(a?.status).toBe('running')
		expect(calls.filter((c) => c[0] === 'snapshot' && c[1] === 'restore')).toHaveLength(1)
	})

	it('keeps the desktop running when the snapshot fails', async () => {
		const { msb, calls, sandboxes, clock } = makeSnapshotMsb({ failSnapshot: true })
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false)

		expect(registry.get(WS_A, AGENT_A)?.status).toBe('running')
		expect(calls.some((c) => c[0] === 'stop')).toBe(false)
		expect(sandboxes.size).toBe(1)
		expect(await exists(archiveFor(WS_A))).toBe(false)
	})

	it('keeps the archive and stays suspended when a restore fails', async () => {
		const { msb, clock } = makeSnapshotMsb({ failRestore: true })
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await registry.suspend(WS_A, AGENT_A)

		expect(await registry.ensure(WS_A, AGENT_A)).toBeNull()

		expect(registry.get(WS_A, AGENT_A)?.status).toBe('suspended')
		expect(await exists(archiveFor(WS_A))).toBe(true)
	})

	it('remove deletes a suspended desktop and its archive', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await registry.suspend(WS_A, AGENT_A)

		expect(await registry.remove(WS_A, AGENT_A)).toBe(true)

		expect(registry.get(WS_A, AGENT_A)).toBeUndefined()
		expect(await exists(archiveFor(WS_A))).toBe(false)
	})

	it('adopts a suspended desktop after a restart when its archive is still there', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const first = makeRegistry(msb)
		await first.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await first.suspend(WS_A, AGENT_A)

		const restarted = makeRegistry(msb)
		await restarted.reconcile([]) // a suspended desktop has no VM by design

		expect(restarted.get(WS_A, AGENT_A)?.status).toBe('suspended')
		expect((await restarted.ensure(WS_A, AGENT_A))?.status).toBe('running')
	})

	it('drops a suspended desktop whose archive has gone missing', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const first = makeRegistry(msb)
		await first.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await first.suspend(WS_A, AGENT_A)
		await rm(archiveFor(WS_A))

		const restarted = makeRegistry(msb)
		await restarted.reconcile([])

		expect(restarted.get(WS_A, AGENT_A)).toBeUndefined()
	})

	it('keeps two agents in one workspace on separate desktops that suspend independently', async () => {
		const { msb, calls, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		const a = await registry.ensure(WS_A, AGENT_A)
		const b = await registry.ensure(WS_A, AGENT_B)
		expect(a?.name).not.toBe(b?.name)
		expect(a?.password).not.toBe(b?.password)
		expect(a?.hostPort).not.toBe(b?.hostPort)
		expect(
			registry
				.listForWorkspace(WS_A)
				.map((d) => d.agentId)
				.sort(),
		).toEqual([AGENT_A, AGENT_B].sort())
		clock.t += IDLE_MS
		registry.touch(WS_A, AGENT_B) // only B is in use

		await registry.sweepIdle()

		expect(registry.get(WS_A, AGENT_A)?.status).toBe('suspended')
		expect(registry.get(WS_A, AGENT_B)?.status).toBe('running')
		// Waking A must not touch B.
		await registry.ensure(WS_A, AGENT_A)
		const restores = calls.filter((c) => c[0] === 'snapshot' && c[1] === 'restore')
		expect(restores).toHaveLength(1)
		expect(restores[0]?.[2]).toBe(archiveFor(WS_A, AGENT_A))
	})

	it('does not share a desktop between the same agent id in two workspaces', async () => {
		const { msb } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		const a = await registry.ensure(WS_A, AGENT_A)
		const b = await registry.ensure(WS_B, AGENT_A)
		expect(a?.name).not.toBe(b?.name)
		expect(registry.listForWorkspace(WS_A)).toHaveLength(1)
		expect(registry.get(WS_B, AGENT_B)).toBeUndefined()
	})

	it('writes an archive that only its owner can read, in a directory only its owner can enter', async () => {
		if (process.platform === 'win32') return // POSIX modes are not meaningful on Windows
		const { msb, clock } = makeSnapshotMsb()
		const registry = makeRegistry(msb)
		await registry.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await registry.suspend(WS_A, AGENT_A)

		expect((await stat(archiveFor(WS_A))).mode & 0o777).toBe(0o600)
		expect((await stat(snapDir)).mode & 0o777).toBe(0o700)
	})

	it('deletes snapshot archives that no suspended desktop owns when it starts', async () => {
		const { msb, clock } = makeSnapshotMsb()
		const first = makeRegistry(msb)
		await first.ensure(WS_A, AGENT_A)
		clock.t += IDLE_MS
		await first.suspend(WS_A, AGENT_A)
		// Leftovers: a removed agent's archive, an old per-workspace one, a half-written one.
		const stray = [
			archiveFor(WS_A, AGENT_B),
			join(snapDir, `${DESKTOP_PREFIX}${WS_A}.msb`),
			join(snapDir, `${desktopName(WS_B, AGENT_A)}.partial.msb`),
		]
		for (const file of stray) await writeFile(file, 'old machine')

		const restarted = makeRegistry(msb)
		await restarted.reconcile([])

		for (const file of stray) expect(await exists(file)).toBe(false)
		expect(await exists(archiveFor(WS_A))).toBe(true)
		expect(restarted.get(WS_A, AGENT_A)?.status).toBe('suspended')
	})

	it('drops state and VMs left over from one-desktop-per-workspace', async () => {
		const { msb, calls } = makeSnapshotMsb()
		await mkdir(dirname(stateFile), { recursive: true })
		await writeFile(
			stateFile,
			JSON.stringify({ [WS_A]: { hostPort: 41000, controlPort: 41001, password: 'old-pw' } }),
		)
		const registry = makeRegistry(msb)

		await registry.reconcile([`${DESKTOP_PREFIX}${WS_A}`])

		expect(registry.listForWorkspace(WS_A)).toEqual([])
		expect(calls.filter((c) => c[0] === 'remove').map((c) => c[c.length - 1])).toEqual([
			`${DESKTOP_PREFIX}${WS_A}`,
		])
	})

	it('never suspends when snapshots are not configured', async () => {
		const { msb, calls } = makeSnapshotMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await registry.ensure(WS_A, AGENT_A)

		expect(await registry.suspend(WS_A, AGENT_A)).toBe(false)
		await registry.sweepIdle()

		expect(calls.some((c) => c[0] === 'snapshot')).toBe(false)
		// And it starts the desktop the old way: create + exec.
		expect(calls.some((c) => c[0] === 'create')).toBe(true)
	})

	describe('stream upgrade', () => {
		let upstream: Server
		let upstreamPort: number

		beforeEach(async () => {
			upstream = createServer((sock) => {
				sock.on('data', () => sock.write('HTTP/1.1 101 Switching Protocols\r\n\r\npong'))
			})
			await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
			upstreamPort = (upstream.address() as AddressInfo).port
		})
		afterEach(() => {
			upstream.close()
		})

		it('wakes a suspended desktop before splicing the stream', async () => {
			const { msb } = makeSnapshotMsb()
			const registry = new WorkspaceDesktopRegistry({
				msb: { ...msb, findPort: async () => upstreamPort },
				image: 'd',
				stateFile,
				bridgeGateway: '127.0.0.1',
				fetchImpl,
				snapshots: { dir: snapDir, idleSuspendMs: 0 },
			})
			await registry.ensure(WS_A, AGENT_A)
			await registry.suspend(WS_A, AGENT_A) // idleSuspendMs 0: an explicit suspend, no idle check
			expect(registry.get(WS_A, AGENT_A)?.status).toBe('suspended')

			const gate = createServer((serverSide) => {
				handleDesktopUpgrade(
					{
						url: `/desktops/${WS_A}/${AGENT_A}/stream`,
						headers: { authorization: `Bearer ${SECRET}` },
						rawHeaders: ['Authorization', `Bearer ${SECRET}`],
					} as never,
					serverSide,
					Buffer.alloc(0),
					{ registry, secret: SECRET },
				)
			})
			await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r))
			const port = (gate.address() as AddressInfo).port
			const out = await new Promise<string>((resolve) => {
				const client = connect({ host: '127.0.0.1', port })
				let buf = ''
				client.on('connect', () => client.write('x'))
				client.on('data', (d) => {
					buf += d.toString()
					if (buf.includes('pong')) client.destroy()
				})
				client.on('close', () => resolve(buf))
			})
			gate.close()

			expect(out).toContain('pong')
			expect(registry.get(WS_A, AGENT_A)?.status).toBe('running')
		})
	})
})
