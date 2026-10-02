import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { logger } from '../lib/logger'
import {
	DEFAULT_BRIDGE_GATEWAY,
	DENY_HOST_ALIAS_IPV6_RESET_RULE,
	DNS_TCP_RULE,
	DNS_UDP_RULE,
	type MicrosandboxDeps,
	PUBLIC_EGRESS_RULE,
	assertValidSessionId,
	defaultRunner,
	defaultSleep,
	findFreeHostPort,
	releaseHostPort,
	waitForRunning,
} from './microsandbox'

// One long-lived desktop microVM per workspace (Xvfb + openbox + Chromium,
// streamed over noVNC — see docker/desktop-test). Unlike a session VM or a
// browser sidecar it is NOT tied to any session: it is created on demand,
// survives agent-server restarts, and is removed only on an explicit DELETE.
//
// The prefix is load-bearing. reconcileOnBoot (index.ts) reports every sandbox
// name it doesn't recognise to apps/dev, which treats any unclaimed one as an
// orphan and removes it. Desktops have no session row, so they must be
// excluded from that report by this prefix, exactly like BROWSER_SIDECAR_PREFIX.
export const DESKTOP_PREFIX = 'anko-desktop-'

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Full XFCE-less desktop plus Chromium and an agent CLI is heavier than a
// session VM. Proof-of-concept sizing — revisit once measured.
const DESKTOP_MEMORY_MIB = 3072
const DESKTOP_CPUS = 2
const DESKTOP_GUEST_PORT = 6080
// desktopd (docker/desktop-test/desktopd.py): the agent control API.
const DESKTOP_CONTROL_GUEST_PORT = 6081
const CONTROL_REQUEST_TIMEOUT_MS = 150_000
const DESKTOP_CREATE_TIMEOUT_MS = 120_000
const DESKTOP_REMOVE_TIMEOUT_MS = 30_000
const DESKTOP_READY_TIMEOUT_MS = 60_000

export type WorkspaceDesktop = {
	workspaceId: string
	name: string
	hostPort: number
	// Host side of desktopd's published port.
	controlPort: number
	// VNC password, generated per desktop. Handed to apps/dev (never the
	// browser directly) so other VMs on the msb bridge can't connect without it.
	password: string
}

export function desktopName(workspaceId: string): string {
	if (!WORKSPACE_ID_RE.test(workspaceId)) {
		throw new Error(`Invalid workspace id: ${JSON.stringify(workspaceId)}`)
	}
	const name = `${DESKTOP_PREFIX}${workspaceId.toLowerCase()}`
	assertValidSessionId(name)
	return name
}

export function isValidWorkspaceId(workspaceId: string): boolean {
	return WORKSPACE_ID_RE.test(workspaceId)
}

export type WorkspaceDesktopRegistryDeps = {
	msb: MicrosandboxDeps
	image: string
	// JSON file the registry persists to, so a restarted agent-server can
	// re-adopt desktops that are still running. Holds VNC passwords — written 0600.
	stateFile: string
	bridgeGateway?: string
	fetchImpl?: typeof fetch
}

type PersistedDesktop = { hostPort: number; controlPort?: number; password: string }

export class WorkspaceDesktopRegistry {
	private readonly desktops = new Map<string, WorkspaceDesktop>()
	// Coalesces concurrent ensure() calls for the same workspace onto one
	// provision attempt — a second `msb create` with the same name would fail
	// and then tear down the first one's VM.
	private readonly pending = new Map<string, Promise<WorkspaceDesktop | null>>()
	private readonly bridgeGateway: string

	constructor(private readonly deps: WorkspaceDesktopRegistryDeps) {
		this.bridgeGateway = deps.bridgeGateway ?? DEFAULT_BRIDGE_GATEWAY
	}

	get gateway(): string {
		return this.bridgeGateway
	}

	get(workspaceId: string): WorkspaceDesktop | undefined {
		return this.desktops.get(workspaceId.toLowerCase())
	}

	/** Idempotent: returns the running desktop, provisioning one if needed. */
	ensure(workspaceId: string): Promise<WorkspaceDesktop | null> {
		const id = workspaceId.toLowerCase()
		desktopName(id) // validates
		const inFlight = this.pending.get(id)
		if (inFlight) return inFlight
		const attempt = this.ensureInner(id).finally(() => this.pending.delete(id))
		this.pending.set(id, attempt)
		return attempt
	}

	private async ensureInner(id: string): Promise<WorkspaceDesktop | null> {
		const existing = this.desktops.get(id)
		if (existing) {
			if (await this.isRunning(existing.name)) return existing
			// Registered but the VM is gone (host reboot, manual removal).
			logger.warn('workspace desktop registered but not running, re-provisioning', {
				workspaceId: id,
			})
			this.desktops.delete(id)
			await this.persist()
			await this.removeQuietly(existing.name)
		}
		const created = await this.provision(id)
		if (!created) return null
		this.desktops.set(id, created)
		await this.persist()
		return created
	}

	async remove(workspaceId: string): Promise<boolean> {
		const id = workspaceId.toLowerCase()
		const name = desktopName(id)
		const had = this.desktops.delete(id)
		await this.persist()
		await this.removeQuietly(name)
		return had
	}

	/**
	 * Boot-time pass, called once with the names `msb list` returned: adopt
	 * desktops that survived the restart, remove any `anko-desktop-*` sandbox we
	 * have no state for (no password, so unusable) and drop state for VMs that
	 * no longer exist.
	 */
	async reconcile(sandboxNames: readonly string[]): Promise<void> {
		const present = new Set(sandboxNames.filter((n) => n.startsWith(DESKTOP_PREFIX)))
		const persisted = await this.readState()
		for (const [workspaceId, entry] of Object.entries(persisted)) {
			if (!isValidWorkspaceId(workspaceId)) continue
			const name = desktopName(workspaceId)
			if (!present.delete(name)) continue
			// A desktop from before the control API has no controlPort and an image
			// without desktopd: viewable but never drivable by an agent. Put it back in
			// `present` so the sweep below removes it and the next ensure() provisions
			// a current one.
			if (typeof entry.controlPort !== 'number') {
				present.add(name)
				continue
			}
			this.desktops.set(workspaceId, {
				workspaceId,
				name,
				hostPort: entry.hostPort,
				controlPort: entry.controlPort,
				password: entry.password,
			})
		}
		for (const name of present) {
			logger.warn('removing workspace desktop with no persisted state', { name })
			await this.removeQuietly(name)
		}
		await this.persist()
		logger.info('workspace desktops reconciled', { adopted: this.desktops.size })
	}

	private async provision(workspaceId: string): Promise<WorkspaceDesktop | null> {
		const { msb, image } = this.deps
		const name = desktopName(workspaceId)
		const run = msb.run ?? defaultRunner()
		const sleep = msb.sleep ?? defaultSleep
		const now = msb.now ?? Date.now
		const findPort = msb.findPort ?? findFreeHostPort

		let hostPort: number
		let controlPort: number
		try {
			hostPort = await findPort(this.bridgeGateway)
			controlPort = await findPort(this.bridgeGateway)
		} catch (err) {
			logger.error('workspace desktop: failed to allocate host port', {
				workspaceId,
				error: String(err),
			})
			return null
		}
		const password = randomBytes(18).toString('base64url')

		const createArgs = [
			'create',
			'--name',
			name,
			'--memory',
			`${DESKTOP_MEMORY_MIB}M`,
			'--cpus',
			String(DESKTOP_CPUS),
			'--pull',
			'always',
			'--quiet',
			// Bridge-only publish of noVNC. Deliberately NO allow@private rule:
			// unlike the browser sidecar, nothing needs to reach other VMs from
			// here, and a desktop that can is a lateral-movement path.
			'-p',
			`${this.bridgeGateway}:${hostPort}:${DESKTOP_GUEST_PORT}`,
			'-p',
			`${this.bridgeGateway}:${controlPort}:${DESKTOP_CONTROL_GUEST_PORT}`,
			'--net-rule',
			DENY_HOST_ALIAS_IPV6_RESET_RULE,
			'--net-rule',
			PUBLIC_EGRESS_RULE,
			'--net-rule',
			DNS_UDP_RULE,
			'--net-rule',
			DNS_TCP_RULE,
			'-e',
			`VNC_PASSWORD=${password}`,
			image,
		]

		// msb create binds hostPort itself, so release our reservation first.
		releaseHostPort(hostPort)
		releaseHostPort(controlPort)
		try {
			await run(msb.msbBin, createArgs, { timeoutMs: DESKTOP_CREATE_TIMEOUT_MS })
			await waitForRunning(msb.msbBin, name, { run, sleep, now })
			this.launchEntrypoint(name)
			// Not a TCP poll: msb's port forwarder accepts connections on the host
			// before anything listens in the guest, so a TCP connect succeeds at
			// once and a stream opened right after provisioning hangs. desktopd's
			// /healthz only answers 200 when X and noVNC are really up.
			await this.waitUntilReady(controlPort, { sleep, now })
		} catch (err) {
			const e = err as { stderr?: unknown; message?: string }
			logger.error('workspace desktop provision failed', {
				workspaceId,
				stderr: e.stderr ? String(e.stderr) : '',
				message: e.message ?? 'unknown',
			})
			await this.removeQuietly(name)
			return null
		}

		logger.info('workspace desktop started', { workspaceId, name, hostPort, controlPort })
		return { workspaceId, name, hostPort, controlPort, password }
	}

	// `msb create` boots the VM but does not run ENTRYPOINT — `msb exec` does.
	private launchEntrypoint(name: string): void {
		const spawner = this.deps.msb.spawnProcess ?? spawn
		const proc = spawner(this.deps.msb.msbBin, ['exec', name], { stdio: 'ignore' })
		proc.on('error', (err) => {
			logger.error('workspace desktop exec spawn error', { name, error: String(err) })
		})
		proc.on('close', (code, sig) => {
			logger.info('workspace desktop exec process exited', { name, code, signal: sig })
		})
		proc.unref()
	}

	private async waitUntilReady(
		controlPort: number,
		clock: { sleep: (ms: number) => Promise<void>; now: () => number },
	): Promise<void> {
		const doFetch = this.deps.fetchImpl ?? fetch
		const deadline = clock.now() + DESKTOP_READY_TIMEOUT_MS
		while (clock.now() < deadline) {
			try {
				const res = await doFetch(`http://${this.bridgeGateway}:${controlPort}/healthz`, {
					signal: AbortSignal.timeout(3_000),
				})
				if (res.ok) return
			} catch {
				// not listening yet
			}
			await clock.sleep(500)
		}
		throw new Error(`desktop did not become ready within ${DESKTOP_READY_TIMEOUT_MS}ms`)
	}

	/**
	 * Proxies one request to the desktop's desktopd. Returns null if there is no
	 * such desktop. Authenticates with the desktop's own password, which never
	 * leaves this process.
	 */
	async control(
		workspaceId: string,
		path: '/screenshot' | '/input' | '/exec',
		body: unknown,
	): Promise<{ status: number; body: unknown } | null> {
		const desktop = this.get(workspaceId)
		if (!desktop) return null
		const doFetch = this.deps.fetchImpl ?? fetch
		const res = await doFetch(`http://${this.bridgeGateway}:${desktop.controlPort}${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${desktop.password}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
		})
		const parsed: unknown = await res.json().catch(() => ({ error: 'bad_gateway' }))
		return { status: res.status, body: parsed }
	}

	private async isRunning(name: string): Promise<boolean> {
		const run = this.deps.msb.run ?? defaultRunner()
		try {
			const { stdout } = await run(this.deps.msb.msbBin, ['list', '--format', 'json'], {
				timeoutMs: 10_000,
			})
			const list = JSON.parse(stdout) as Array<{ name: string; status: string }>
			return list.some((s) => s.name === name && s.status?.toLowerCase() === 'running')
		} catch {
			// Unknown, not absent: a transient msb hiccup must not trigger a
			// destructive re-provision of a desktop someone may be using.
			return true
		}
	}

	private async removeQuietly(name: string): Promise<void> {
		try {
			const run = this.deps.msb.run ?? defaultRunner()
			await run(this.deps.msb.msbBin, ['remove', '-f', '--quiet', name], {
				timeoutMs: DESKTOP_REMOVE_TIMEOUT_MS,
			})
		} catch (err) {
			logger.warn('workspace desktop removal did not confirm', { name, error: String(err) })
		}
	}

	private async readState(): Promise<Record<string, PersistedDesktop>> {
		try {
			return JSON.parse(await readFile(this.deps.stateFile, 'utf8')) as Record<
				string,
				PersistedDesktop
			>
		} catch {
			return {}
		}
	}

	private async persist(): Promise<void> {
		const state: Record<string, PersistedDesktop> = {}
		for (const d of this.desktops.values()) {
			state[d.workspaceId] = {
				hostPort: d.hostPort,
				controlPort: d.controlPort,
				password: d.password,
			}
		}
		try {
			await mkdir(dirname(this.deps.stateFile), { recursive: true })
			const tmp = `${this.deps.stateFile}.tmp`
			await writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
			await rename(tmp, this.deps.stateFile)
		} catch (err) {
			// A lost state file only costs re-adoption after a restart (the
			// orphan sweep then removes the VM); it must not fail the request.
			logger.error('workspace desktop state persist failed', { error: String(err) })
		}
	}
}

const STREAM_PATH_RE = /^\/desktops\/([0-9a-f-]{36})\/stream$/i

function secretMatches(header: string | undefined, secret: string): boolean {
	if (!header) return false
	const a = Buffer.from(header)
	const b = Buffer.from(`Bearer ${secret}`)
	return a.length === b.length && timingSafeEqual(a, b)
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Handles `GET /desktops/:workspaceId/stream` WebSocket upgrades by splicing
 * the client socket onto the desktop's noVNC (websockify) port at the TCP
 * level. No WebSocket library is needed: we authenticate the upgrade request,
 * replay it to websockify, and then pipe bytes both ways, so websockify does
 * the actual WebSocket handshake and framing.
 *
 * Authentication is the same shared bearer as every other /sessions-style
 * route — apps/dev is the only caller; browsers never reach this server.
 */
export function handleDesktopUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	deps: { registry: WorkspaceDesktopRegistry; secret: string },
): void {
	const path = (req.url ?? '').split('?')[0] ?? ''
	const match = STREAM_PATH_RE.exec(path)
	if (!match) {
		rejectUpgrade(socket, 404, 'Not Found')
		return
	}
	if (!secretMatches(req.headers.authorization, deps.secret)) {
		rejectUpgrade(socket, 401, 'Unauthorized')
		return
	}
	const desktop = deps.registry.get(match[1] as string)
	if (!desktop) {
		rejectUpgrade(socket, 404, 'Not Found')
		return
	}

	const upstream = connect({ host: deps.registry.gateway, port: desktop.hostPort })
	const teardown = (): void => {
		socket.destroy()
		upstream.destroy()
	}
	upstream.on('error', (err) => {
		logger.warn('workspace desktop stream upstream error', {
			workspaceId: desktop.workspaceId,
			error: String(err),
		})
		teardown()
	})
	socket.on('error', teardown)
	socket.on('close', teardown)
	upstream.on('close', teardown)

	upstream.on('connect', () => {
		// Replay the handshake to websockify, minus our bearer, pointed at its
		// own path and host.
		const lines = ['GET /websockify HTTP/1.1', `Host: ${deps.registry.gateway}:${desktop.hostPort}`]
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const key = req.rawHeaders[i] as string
			const lower = key.toLowerCase()
			if (lower === 'authorization' || lower === 'host') continue
			lines.push(`${key}: ${req.rawHeaders[i + 1]}`)
		}
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
		if (head.length > 0) upstream.write(head)
		socket.pipe(upstream)
		upstream.pipe(socket)
	})
}
