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
	isValidWorkspaceId,
} from '../services/workspace-desktop'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'
const SECRET = 'test-secret-thirty-two-chars-long'

function fakeSpawn(): { spawnProcess: ProcessSpawner; execs: string[][] } {
	const execs: string[][] = []
	const spawnProcess: ProcessSpawner = (_bin, args) => {
		execs.push([...args])
		const proc = new EventEmitter() as unknown as ChildProcess
		proc.unref = () => proc
		proc.kill = () => true
		return proc
	}
	return { spawnProcess, execs }
}

// A fake msb: tracks created sandboxes, lists them as Running.
function makeMsb(opts: { failCreate?: boolean } = {}) {
	const calls: string[][] = []
	const sandboxes = new Set<string>()
	const { spawnProcess, execs } = fakeSpawn()
	let nextPort = 41000
	const msb: MicrosandboxDeps = {
		msbBin: '/fake/msb',
		run: async (_bin, args) => {
			calls.push([...args])
			if (args[0] === 'create') {
				if (opts.failCreate) throw Object.assign(new Error('boom'), { stderr: 'no image' })
				sandboxes.add(args[args.indexOf('--name') + 1] as string)
			}
			if (args[0] === 'remove') sandboxes.delete(args[args.length - 1] as string)
			if (args[0] === 'list') {
				return {
					stdout: JSON.stringify([...sandboxes].map((name) => ({ name, status: 'Running' }))),
					stderr: '',
				}
			}
			return { stdout: '', stderr: '' }
		},
		sleep: async () => {},
		findPort: async () => nextPort++,
		tcpPollReady: async () => {},
		spawnProcess,
	}
	return { msb, calls, sandboxes, execs }
}

// Stands in for desktopd: /healthz answers 200 once `failHealthzTimes` refusals
// have been served; every POST echoes its JSON body back.
function makeFetch(opts: { failHealthzTimes?: number } = {}) {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	let failures = opts.failHealthzTimes ?? 0
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init })
		if (String(url).endsWith('/healthz')) {
			if (failures-- > 0) throw new Error('ECONNREFUSED')
			return new Response('{"ready":true}', { status: 200 })
		}
		const echoed = JSON.parse(String(init?.body ?? '{}'))
		return new Response(JSON.stringify({ ok: true, echoed }), { status: 200 })
	}) as typeof fetch
	return { fetchImpl, calls }
}
const { fetchImpl } = makeFetch()

describe('desktopName', () => {
	it('prefixes and lowercases a workspace uuid', () => {
		expect(desktopName(WS_A.toUpperCase())).toBe(`${DESKTOP_PREFIX}${WS_A}`)
	})

	it.each(['', 'not-a-uuid', '../etc/passwd', `${WS_A};rm -rf /`, `${WS_A}\n`])(
		'rejects %j',
		(bad) => {
			expect(() => desktopName(bad)).toThrow(/Invalid workspace id/)
			expect(isValidWorkspaceId(bad)).toBe(false)
		},
	)
})

describe('WorkspaceDesktopRegistry', () => {
	let dir: string
	let stateFile: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'desktop-test-'))
		stateFile = join(dir, 'state', 'desktops.json')
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('creates a bridge-only desktop with a password and starts its entrypoint', async () => {
		const { msb, calls, execs } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({
			msb,
			image: 'desktop:test',
			stateFile,
			fetchImpl,
		})

		const desktop = await registry.ensure(WS_A)

		expect(desktop).toMatchObject({ workspaceId: WS_A, name: `${DESKTOP_PREFIX}${WS_A}` })
		expect(desktop?.password.length).toBeGreaterThanOrEqual(16)
		const create = calls.find((c) => c[0] === 'create') as string[]
		expect(create).toContain('-p')
		const publishes = create.flatMap((arg, i) => (arg === '-p' ? [create[i + 1]] : []))
		expect(publishes).toEqual([
			`10.0.1.1:${desktop?.hostPort}:6080`,
			`10.0.1.1:${desktop?.controlPort}:6081`,
		])
		expect(create).toContain(`VNC_PASSWORD=${desktop?.password}`)
		expect(create[create.length - 1]).toBe('desktop:test')
		// Must not be able to reach other VMs on the bridge.
		expect(create).not.toContain('allow@private')
		expect(execs).toEqual([['exec', `${DESKTOP_PREFIX}${WS_A}`]])
	})

	it('is idempotent: a second ensure reuses the running desktop', async () => {
		const { msb, calls } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		const first = await registry.ensure(WS_A)
		const second = await registry.ensure(WS_A)

		expect(second).toBe(first)
		expect(calls.filter((c) => c[0] === 'create')).toHaveLength(1)
	})

	it('coalesces concurrent ensure calls onto one provision', async () => {
		const { msb, calls } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		const [a, b] = await Promise.all([registry.ensure(WS_A), registry.ensure(WS_A)])

		expect(a).toBe(b)
		expect(calls.filter((c) => c[0] === 'create')).toHaveLength(1)
	})

	it('gives each workspace its own desktop', async () => {
		const { msb } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		const a = await registry.ensure(WS_A)
		const b = await registry.ensure(WS_B)

		expect(a?.name).not.toBe(b?.name)
		expect(a?.hostPort).not.toBe(b?.hostPort)
		expect(a?.password).not.toBe(b?.password)
	})

	it('re-provisions when the registered VM is no longer running', async () => {
		const { msb, calls, sandboxes } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await registry.ensure(WS_A)
		sandboxes.clear() // VM vanished (host reboot, manual removal)

		await registry.ensure(WS_A)

		expect(calls.filter((c) => c[0] === 'create')).toHaveLength(2)
	})

	it('returns null and cleans up when create fails', async () => {
		const { msb, calls } = makeMsb({ failCreate: true })
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		expect(await registry.ensure(WS_A)).toBeNull()
		expect(registry.get(WS_A)).toBeUndefined()
		expect(calls.some((c) => c[0] === 'remove')).toBe(true)
	})

	it('persists state 0600-style and adopts it after a restart', async () => {
		const { msb, sandboxes } = makeMsb()
		const first = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		const created = await first.ensure(WS_A)
		expect((await stat(stateFile)).isFile()).toBe(true)

		const restarted = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await restarted.reconcile([...sandboxes])

		expect(restarted.get(WS_A)).toEqual(created)
	})

	it('reconcile removes desktop sandboxes it has no state for and ignores other sandboxes', async () => {
		const { msb, calls } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		await registry.reconcile([`${DESKTOP_PREFIX}${WS_B}`, 'some-session-id'])

		const removed = calls.filter((c) => c[0] === 'remove').map((c) => c[c.length - 1])
		expect(removed).toEqual([`${DESKTOP_PREFIX}${WS_B}`])
		expect(registry.get(WS_B)).toBeUndefined()
	})

	it('reconcile drops state whose VM no longer exists', async () => {
		const { msb } = makeMsb()
		const first = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await first.ensure(WS_A)

		const restarted = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await restarted.reconcile([]) // msb list shows nothing

		expect(restarted.get(WS_A)).toBeUndefined()
		expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({})
	})

	it('waits for desktopd /healthz instead of trusting a TCP connect', async () => {
		const { msb } = makeMsb()
		const { fetchImpl: flaky, calls } = makeFetch({ failHealthzTimes: 2 })
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl: flaky })

		const desktop = await registry.ensure(WS_A)

		expect(desktop).not.toBeNull()
		expect(calls.filter((c) => c.url.endsWith('/healthz'))).toHaveLength(3)
	})

	it('control forwards to desktopd with the desktop password and returns its reply', async () => {
		const { msb } = makeMsb()
		const { fetchImpl: spy, calls } = makeFetch()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl: spy })
		const desktop = await registry.ensure(WS_A)

		const result = await registry.control(WS_A, '/input', { action: 'move', x: 1, y: 2 })

		expect(result).toEqual({
			status: 200,
			body: { ok: true, echoed: { action: 'move', x: 1, y: 2 } },
		})
		const call = calls.filter((c) => c.url.endsWith('/input')).at(-1)
		expect(call?.url).toBe(`http://10.0.1.1:${desktop?.controlPort}/input`)
		expect((call?.init?.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${desktop?.password}`,
		)
	})

	it('control returns null for a workspace with no desktop', async () => {
		const { msb } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		expect(await registry.control(WS_B, '/screenshot', {})).toBeNull()
	})

	it('reconcile removes a pre-control-API desktop instead of adopting one agents cannot drive', async () => {
		const { msb, calls } = makeMsb()
		await mkdir(dirname(stateFile), { recursive: true })
		await writeFile(stateFile, JSON.stringify({ [WS_A]: { hostPort: 41000, password: 'old-pw' } }))
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })

		await registry.reconcile([`${DESKTOP_PREFIX}${WS_A}`])

		expect(registry.get(WS_A)).toBeUndefined()
		expect(calls.filter((c) => c[0] === 'remove').map((c) => c[c.length - 1])).toEqual([
			`${DESKTOP_PREFIX}${WS_A}`,
		])
	})

	it('remove tears the desktop down and forgets it', async () => {
		const { msb, sandboxes } = makeMsb()
		const registry = new WorkspaceDesktopRegistry({ msb, image: 'd', stateFile, fetchImpl })
		await registry.ensure(WS_A)

		expect(await registry.remove(WS_A)).toBe(true)
		expect(registry.get(WS_A)).toBeUndefined()
		expect(sandboxes.size).toBe(0)
		expect(await registry.remove(WS_A)).toBe(false)
	})
})

describe('handleDesktopUpgrade', () => {
	let upstream: Server
	let upstreamPort: number
	let received: string
	let registry: WorkspaceDesktopRegistry
	let dir: string

	beforeEach(async () => {
		received = ''
		// Stands in for websockify: records the replayed handshake, then echoes.
		upstream = createServer((sock) => {
			sock.on('data', (d) => {
				received += d.toString()
				sock.write('HTTP/1.1 101 Switching Protocols\r\n\r\npong')
			})
		})
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
		upstreamPort = (upstream.address() as AddressInfo).port

		dir = await mkdtemp(join(tmpdir(), 'desktop-upgrade-'))
		const { msb } = makeMsb()
		registry = new WorkspaceDesktopRegistry({
			msb: { ...msb, findPort: async () => upstreamPort },
			image: 'd',
			stateFile: join(dir, 'd.json'),
			bridgeGateway: '127.0.0.1',
			fetchImpl,
		})
		await registry.ensure(WS_A)
	})
	afterEach(async () => {
		upstream.close()
		await rm(dir, { recursive: true, force: true })
	})

	function fakeReq(url: string, headers: Record<string, string>) {
		const rawHeaders = Object.entries(headers).flat()
		return {
			url,
			headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
			rawHeaders,
		} as never
	}

	// Runs the handler against a real socket pair so piping is exercised.
	async function upgrade(url: string, headers: Record<string, string>): Promise<string> {
		const gate = createServer((serverSide) => {
			handleDesktopUpgrade(fakeReq(url, headers), serverSide, Buffer.alloc(0), {
				registry,
				secret: SECRET,
			})
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
		return out
	}

	it('rejects a missing or wrong bearer with 401', async () => {
		expect(await upgrade(`/desktops/${WS_A}/stream`, {})).toMatch(/^HTTP\/1\.1 401/)
		expect(await upgrade(`/desktops/${WS_A}/stream`, { Authorization: 'Bearer nope' })).toMatch(
			/^HTTP\/1\.1 401/,
		)
	})

	it('404s an unknown workspace and a bad path', async () => {
		const auth = { Authorization: `Bearer ${SECRET}` }
		expect(await upgrade(`/desktops/${WS_B}/stream`, auth)).toMatch(/^HTTP\/1\.1 404/)
		expect(await upgrade('/sessions/x/stream', auth)).toMatch(/^HTTP\/1\.1 404/)
	})

	it('replays the handshake to websockify without the bearer and pipes data back', async () => {
		const out = await upgrade(`/desktops/${WS_A}/stream`, {
			Authorization: `Bearer ${SECRET}`,
			Host: 'agent-server.example',
			Upgrade: 'websocket',
			Connection: 'Upgrade',
		})

		expect(out).toContain('101 Switching Protocols')
		expect(out).toContain('pong')
		expect(received).toContain('GET /websockify HTTP/1.1')
		expect(received).toContain('Upgrade: websocket')
		expect(received).toContain(`Host: 127.0.0.1:${upstreamPort}`)
		expect(received).not.toContain(SECRET)
		expect(received).not.toContain('agent-server.example')
	})
})
