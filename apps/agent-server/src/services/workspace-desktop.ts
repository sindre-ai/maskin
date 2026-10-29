import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { logger } from '../lib/logger'
import {
	DEFAULT_BRIDGE_GATEWAY,
	DENY_HOST_ALIAS_IPV6_RESET_RULE,
	DNS_TCP_RULE,
	DNS_UDP_RULE,
	type MicrosandboxDeps,
	PUBLIC_EGRESS_RULE,
	type SshRelay,
	assertValidSessionId,
	defaultRunner,
	defaultSleep,
	findFreeHostPort,
	releaseHostPort,
	reserveHostPort,
	sandboxState,
	startSshRelay,
	waitForRunning,
} from './microsandbox'

// One long-lived desktop microVM per AGENT (Xvfb + XFCE + Chromium, streamed over
// noVNC — see docker/desktop). A desktop is identified by the pair
// (workspace, agent): the workspace is the trust boundary for who may look at
// it, the agent is whose computer it is. Nothing else may reach it — an agent
// that is logged in to a service on its desktop must not leak that session to
// another agent, so desktops share no disk, memory or browser profile.
//
// Unlike a session VM or a browser sidecar a desktop is NOT tied to any
// session: it is created on first use, survives agent-server restarts, and is
// removed only on an explicit DELETE.
//
// The prefix is load-bearing. reconcileOnBoot (index.ts) reports every sandbox
// name it doesn't recognise to apps/dev, which treats any unclaimed one as an
// orphan and removes it. Desktops have no session row, so they must be
// excluded from that report by this prefix, so reconcile never reports them as session sandboxes.
export const DESKTOP_PREFIX = 'anko-desktop-'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Full XFCE-less desktop plus Chromium and an agent CLI is heavier than a
// session VM. Proof-of-concept sizing — revisit once measured.
const DESKTOP_MEMORY_MIB = 3072
const DESKTOP_CPUS = 2
const DESKTOP_GUEST_PORT = 6080
// desktopd (docker/desktop/desktopd.py): the agent control API.
const DESKTOP_CONTROL_GUEST_PORT = 6081
const CONTROL_REQUEST_TIMEOUT_MS = 150_000
const DESKTOP_CREATE_TIMEOUT_MS = 120_000
const DESKTOP_REMOVE_TIMEOUT_MS = 30_000
const DESKTOP_READY_TIMEOUT_MS = 60_000
// Measured on msb 0.7.8 with a 3 GiB desktop and Chromium open: ~9s to write a
// zstd archive, ~5s to restore one. 120s leaves room for a busy host.
const DESKTOP_SNAPSHOT_TIMEOUT_MS = 120_000
const DESKTOP_RESTORE_TIMEOUT_MS = 120_000
const DESKTOP_STOP_TIMEOUT_MS = 30_000
// Hard ceiling on one queued operation for one desktop. Every step inside has
// its own timeout, so this is only the backstop for a promise that never
// settles: without it that desktop's queue would wedge for good.
const DESKTOP_OPERATION_GUARD_MS = 300_000
const IDLE_SWEEP_INTERVAL_MS = 30_000

export type DesktopStatus = 'running' | 'suspended'

export type WorkspaceDesktop = {
	workspaceId: string
	// The agent whose computer this is.
	agentId: string
	name: string
	hostPort: number
	// Host side of desktopd's published port.
	controlPort: number
	// VNC password, generated per desktop. Handed to apps/dev (never the
	// browser directly) so other VMs on the msb bridge can't connect without it.
	password: string
	// `suspended`: the VM is gone and its whole state — memory included — sits in
	// a snapshot archive. ensure() (or any control call or stream) wakes it.
	status: DesktopStatus
	// First host-loopback port of the block this computer's firewall allows it to
	// reach (see DesktopRelayConfig). Undefined for a computer created before
	// port exposure existed, or when the pool had no block left: its firewall has
	// no such rule and can't be given one without recreating it.
	relayBlockStart?: number
}

export function isValidWorkspaceId(workspaceId: string): boolean {
	return UUID_RE.test(workspaceId)
}

export function isValidAgentId(agentId: string): boolean {
	return UUID_RE.test(agentId)
}

/** The registry key for a desktop: lowercased `workspace:agent`. */
export function desktopKey(workspaceId: string, agentId: string): string {
	if (!UUID_RE.test(workspaceId)) {
		throw new Error(`Invalid workspace id: ${JSON.stringify(workspaceId)}`)
	}
	if (!UUID_RE.test(agentId)) {
		throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`)
	}
	return `${workspaceId.toLowerCase()}:${agentId.toLowerCase()}`
}

// msb uses the sandbox name as the guest HOSTNAME, and a hostname label over 63
// characters breaks things inside (desktopd's gethostbyaddr raised 'label too
// long' and the desktop never became ready). Two UUIDs are 73, so the name carries
// a hash of the pair instead: stable, unique per (workspace, agent), 45 characters.
export function desktopName(workspaceId: string, agentId: string): string {
	const digest = createHash('sha256').update(desktopKey(workspaceId, agentId)).digest('hex')
	const name = `${DESKTOP_PREFIX}${digest.slice(0, 32)}`
	assertValidSessionId(name)
	return name
}

function parseKey(key: string): { workspaceId: string; agentId: string } | null {
	const [workspaceId, agentId, extra] = key.split(':')
	if (!workspaceId || !agentId || extra !== undefined) return null
	if (!UUID_RE.test(workspaceId) || !UUID_RE.test(agentId)) return null
	return { workspaceId: workspaceId.toLowerCase(), agentId: agentId.toLowerCase() }
}

export type DesktopSnapshotConfig = {
	// Where suspended desktops' snapshot archives are written (one file each).
	// An archive holds the whole machine, logged-in sessions included, so the
	// directory is 0700 and every archive 0600.
	dir: string
	// Suspend a desktop after this long with no viewer and no agent call. 0 never
	// suspends automatically.
	idleSuspendMs: number
}

export type DesktopRelayConfig = {
	// Host-loopback ports [portStart, portEnd] are cut into blocks of blockSize,
	// one block per computer, so a computer can reach only its own agent's tunnels.
	portStart: number
	portEnd: number
	blockSize: number
	sshKeyPath: string
}

export type ExposedPort = { guestPort: number; relayPort: number; sessionId: string }

export type ExposePortResult =
	| { ok: true; port: ExposedPort }
	| {
			ok: false
			reason: 'no_desktop' | 'no_relay_block' | 'too_many_ports' | 'relay_failed'
			message: string
	  }

export type WorkspaceDesktopRegistryDeps = {
	msb: MicrosandboxDeps
	image: string
	// JSON file the registry persists to, so a restarted agent-server can
	// re-adopt desktops that are still running. Holds VNC passwords — written 0600.
	stateFile: string
	bridgeGateway?: string
	fetchImpl?: typeof fetch
	// Suspend idle desktops to a full memory snapshot and restore them on demand,
	// so the open windows, browser tabs and half-typed text come back exactly.
	// Needs msb >= 0.7 (`msb snapshot create --full`). Leave unset on older msb:
	// the desktop is then created and started exactly as before.
	snapshots?: DesktopSnapshotConfig
	// Tunnels from a computer to dev servers in its agent's session sandbox. Unset
	// means no computer gets a port block and exposing a port is refused.
	relay?: DesktopRelayConfig
}

type PersistedDesktop = {
	hostPort: number
	controlPort?: number
	password: string
	status?: DesktopStatus
	relayBlockStart?: number
}

export class WorkspaceDesktopRegistry {
	// All maps are keyed by desktopKey(workspaceId, agentId).
	private readonly desktops = new Map<string, WorkspaceDesktop>()
	// Coalesces concurrent ensure() calls for the same desktop onto one
	// provision attempt — a second `msb create` with the same name would fail
	// and then tear down the first one's VM.
	private readonly pending = new Map<string, Promise<WorkspaceDesktop | null>>()
	// Tail of each desktop's operation queue: ensure, suspend and remove for one
	// desktop run one at a time, so a wake can't interleave with a suspend.
	private readonly queues = new Map<string, Promise<unknown>>()
	private readonly lastActivity = new Map<string, number>()
	private readonly viewers = new Map<string, number>()
	// Live tunnels per desktop. In memory only: a restarted agent-server loses its
	// tunnel processes, and the agent simply exposes the port again.
	private readonly relays = new Map<string, Map<number, { relay: SshRelay; sessionId: string }>>()
	private sweepTimer: NodeJS.Timeout | undefined
	private readonly bridgeGateway: string

	constructor(private readonly deps: WorkspaceDesktopRegistryDeps) {
		this.bridgeGateway = deps.bridgeGateway ?? DEFAULT_BRIDGE_GATEWAY
	}

	get gateway(): string {
		return this.bridgeGateway
	}

	get(workspaceId: string, agentId: string): WorkspaceDesktop | undefined {
		return this.desktops.get(desktopKey(workspaceId, agentId))
	}

	/** Every desktop in one workspace (running or suspended). */
	listForWorkspace(workspaceId: string): WorkspaceDesktop[] {
		const ws = workspaceId.toLowerCase()
		return [...this.desktops.values()].filter((d) => d.workspaceId === ws)
	}

	/** Idempotent: returns the running desktop, provisioning or waking one if needed. */
	ensure(workspaceId: string, agentId: string): Promise<WorkspaceDesktop | null> {
		const key = desktopKey(workspaceId, agentId) // validates
		const inFlight = this.pending.get(key)
		if (inFlight) return inFlight
		const attempt = this.enqueue(key, () => this.ensureInner(key)).finally(() =>
			this.pending.delete(key),
		)
		this.pending.set(key, attempt)
		return attempt
	}

	/** Marks the desktop as in use, restarting its idle clock. */
	touch(workspaceId: string, agentId: string): void {
		this.lastActivity.set(desktopKey(workspaceId, agentId), this.now())
	}

	/** A noVNC viewer connected: the desktop is never idle while one is attached. */
	viewerOpened(workspaceId: string, agentId: string): void {
		const key = desktopKey(workspaceId, agentId)
		this.viewers.set(key, (this.viewers.get(key) ?? 0) + 1)
		this.lastActivity.set(key, this.now())
	}

	/** A viewer went away; the idle clock restarts from now, not from when it connected. */
	viewerClosed(workspaceId: string, agentId: string): void {
		const key = desktopKey(workspaceId, agentId)
		const left = (this.viewers.get(key) ?? 0) - 1
		if (left > 0) this.viewers.set(key, left)
		else this.viewers.delete(key)
		this.lastActivity.set(key, this.now())
	}

	async remove(workspaceId: string, agentId: string): Promise<boolean> {
		const key = desktopKey(workspaceId, agentId)
		const name = desktopName(workspaceId, agentId)
		return this.enqueue(key, async () => {
			this.stopAllRelays(key)
			const had = this.desktops.delete(key)
			this.lastActivity.delete(key)
			await this.persist()
			await this.removeQuietly(name)
			await this.removeArchive(name)
			return had
		})
	}

	/** Starts the periodic idle check. No-op unless snapshots are configured with a timeout. */
	startIdleSweep(): void {
		const config = this.deps.snapshots
		if (!config || config.idleSuspendMs <= 0 || this.sweepTimer) return
		this.sweepTimer = setInterval(() => {
			this.sweepIdle().catch((err) => {
				logger.error('workspace desktop idle sweep failed', { error: String(err) })
			})
		}, IDLE_SWEEP_INTERVAL_MS)
		this.sweepTimer.unref()
	}

	stopIdleSweep(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer)
		this.sweepTimer = undefined
	}

	/**
	 * Suspends every running desktop that has had no viewer and no agent call for
	 * `idleSuspendMs`. Safe to overlap with itself or with ensure(): each suspend
	 * re-checks idleness inside the desktop's queue, so a second one finds the
	 * desktop already suspended (or busy again) and does nothing.
	 */
	async sweepIdle(): Promise<void> {
		const config = this.deps.snapshots
		if (!config || config.idleSuspendMs <= 0) return
		for (const desktop of [...this.desktops.values()]) {
			const key = desktopKey(desktop.workspaceId, desktop.agentId)
			if (!this.isIdle(key, config.idleSuspendMs)) continue
			try {
				await this.suspend(desktop.workspaceId, desktop.agentId)
			} catch (err) {
				logger.warn('workspace desktop suspend failed', {
					workspaceId: desktop.workspaceId,
					agentId: desktop.agentId,
					error: String(err),
				})
			}
		}
	}

	/**
	 * Writes a full snapshot (disk, memory, processes) of the running desktop to an
	 * archive, then stops and removes the VM. Returns false if it was not suspended
	 * — not running, not idle any more, snapshots off, or the snapshot failed, in
	 * which case the desktop keeps running untouched.
	 */
	suspend(workspaceId: string, agentId: string): Promise<boolean> {
		const key = desktopKey(workspaceId, agentId) // validates
		return this.enqueue(key, () => this.suspendInner(key))
	}

	/**
	 * Boot-time pass, called once with the names `msb list` returned: adopt
	 * desktops that survived the restart, remove any `anko-desktop-*` sandbox we
	 * have no state for (no password, so unusable) and drop state for VMs that
	 * no longer exist. A suspended desktop has no VM by design, so it is adopted
	 * when its snapshot archive is still on disk. Snapshot archives that belong to
	 * no known suspended desktop are deleted: they hold a logged-in machine.
	 */
	async reconcile(sandboxNames: readonly string[]): Promise<void> {
		const present = new Set(sandboxNames.filter((n) => n.startsWith(DESKTOP_PREFIX)))
		const persisted = await this.readState()
		for (const [key, entry] of Object.entries(persisted)) {
			// Entries from before desktops were per agent are keyed by workspace id
			// alone. They have no agent, so they are dropped, and their VMs removed by
			// the sweep below.
			const ref = parseKey(key)
			if (!ref) continue
			const { workspaceId, agentId } = ref
			const name = desktopName(workspaceId, agentId)
			if (entry.status === 'suspended') {
				if (typeof entry.controlPort === 'number' && (await this.archiveExists(name))) {
					this.desktops.set(key, {
						workspaceId,
						agentId,
						name,
						hostPort: entry.hostPort,
						controlPort: entry.controlPort,
						password: entry.password,
						status: 'suspended',
						...(typeof entry.relayBlockStart === 'number' && {
							relayBlockStart: entry.relayBlockStart,
						}),
					})
					this.lastActivity.set(key, this.now())
				} else {
					logger.warn('suspended workspace desktop has no snapshot archive, dropping it', {
						workspaceId,
						agentId,
					})
				}
				continue
			}
			if (!present.delete(name)) continue
			// A desktop from before the control API has no controlPort and an image
			// without desktopd: viewable but never drivable by an agent. Put it back in
			// `present` so the sweep below removes it and the next ensure() provisions
			// a current one.
			if (typeof entry.controlPort !== 'number') {
				present.add(name)
				continue
			}
			this.desktops.set(key, {
				workspaceId,
				agentId,
				name,
				hostPort: entry.hostPort,
				controlPort: entry.controlPort,
				password: entry.password,
				status: 'running',
				...(typeof entry.relayBlockStart === 'number' && {
					relayBlockStart: entry.relayBlockStart,
				}),
			})
			// A restart must not make every adopted desktop look idle at once.
			this.lastActivity.set(key, this.now())
		}
		for (const name of present) {
			logger.warn('removing workspace desktop with no persisted state', { name })
			await this.removeQuietly(name)
		}
		await this.sweepOrphanArchives()
		await this.persist()
		logger.info('workspace desktops reconciled', { adopted: this.desktops.size })
	}

	private now(): number {
		return (this.deps.msb.now ?? Date.now)()
	}

	private isIdle(key: string, idleMs: number): boolean {
		const desktop = this.desktops.get(key)
		if (!desktop || desktop.status !== 'running') return false
		if ((this.viewers.get(key) ?? 0) > 0) return false
		return this.now() - (this.lastActivity.get(key) ?? 0) >= idleMs
	}

	// Runs `fn` after everything already queued for this desktop, and bounds it
	// with DESKTOP_OPERATION_GUARD_MS so one hung call can't stall the queue.
	private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve()
		const guarded = (): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`desktop operation exceeded ${DESKTOP_OPERATION_GUARD_MS}ms`)),
					DESKTOP_OPERATION_GUARD_MS,
				)
				fn().then(
					(value) => {
						clearTimeout(timer)
						resolve(value)
					},
					(err) => {
						clearTimeout(timer)
						reject(err)
					},
				)
			})
		const run = previous.then(guarded, guarded)
		const tail = run.catch(() => undefined)
		this.queues.set(key, tail)
		tail.then(() => {
			if (this.queues.get(key) === tail) this.queues.delete(key)
		})
		return run
	}

	private async ensureInner(key: string): Promise<WorkspaceDesktop | null> {
		const ref = parseKey(key) as { workspaceId: string; agentId: string }
		const existing = this.desktops.get(key)
		if (existing?.status === 'suspended') {
			if (!(await this.resume(existing))) return null
			this.lastActivity.set(key, this.now())
			return existing
		}
		if (existing) {
			if (await this.isRunning(existing.name)) {
				this.lastActivity.set(key, this.now())
				return existing
			}
			// Registered but the VM is gone (host reboot, manual removal).
			logger.warn('workspace desktop registered but not running, re-provisioning', ref)
			this.desktops.delete(key)
			await this.persist()
			await this.removeQuietly(existing.name)
		}
		const created = await this.provision(ref.workspaceId, ref.agentId)
		if (!created) return null
		this.desktops.set(key, created)
		this.lastActivity.set(key, this.now())
		await this.persist()
		return created
	}

	private async suspendInner(key: string): Promise<boolean> {
		const config = this.deps.snapshots
		const desktop = this.desktops.get(key)
		if (!config || !desktop || desktop.status !== 'running') return false
		// Re-checked here, inside the queue: the desktop may have been used since
		// the sweep decided it was idle. An explicit suspend (idleSuspendMs 0) skips it.
		if (config.idleSuspendMs > 0 && !this.isIdle(key, config.idleSuspendMs)) return false

		const { msb } = this.deps
		const run = msb.run ?? defaultRunner()
		const archive = this.archivePath(desktop.name)
		const partial = join(config.dir, `${desktop.name}.partial.msb`)
		const ref = { workspaceId: desktop.workspaceId, agentId: desktop.agentId }
		try {
			await mkdir(config.dir, { recursive: true, mode: 0o700 })
			// mkdir leaves an existing directory's mode alone, so set it explicitly.
			await chmod(config.dir, 0o700)
			// A standalone archive, not an installed snapshot: msb groups snapshots into
			// lineages whose head can't be removed, and every one costs ~1 GB of disk
			// forever. A file we write, restore from and delete has none of that.
			await run(
				msb.msbBin,
				['snapshot', 'create', '--sandbox', desktop.name, '--full', '--quiet', '-f', '-o', partial],
				{ timeoutMs: DESKTOP_SNAPSHOT_TIMEOUT_MS },
			)
			// The archive is the whole machine, logged-in sessions included: owner only.
			await chmod(partial, 0o600)
			await rename(partial, archive)
		} catch (err) {
			// The VM is untouched and still running: nothing was lost.
			logger.warn('workspace desktop snapshot failed, leaving it running', {
				...ref,
				error: String(err),
			})
			await rm(partial, { force: true })
			return false
		}

		try {
			await run(msb.msbBin, ['stop', desktop.name], { timeoutMs: DESKTOP_STOP_TIMEOUT_MS })
		} catch (err) {
			// Still running (or half stopped): a snapshot we can't restore over a live VM
			// is worse than none, so drop the archive and carry on as before.
			logger.warn('workspace desktop stop failed after snapshot, keeping it running', {
				...ref,
				error: String(err),
			})
			await this.removeArchive(desktop.name)
			return false
		}
		await this.removeQuietly(desktop.name)
		desktop.status = 'suspended'
		await this.persist()
		logger.info('workspace desktop suspended', ref)
		return true
	}

	/** Restores a suspended desktop from its archive. On failure the archive is kept. */
	private async resume(desktop: WorkspaceDesktop): Promise<boolean> {
		const { msb } = this.deps
		const run = msb.run ?? defaultRunner()
		const sleep = msb.sleep ?? defaultSleep
		const now = msb.now ?? Date.now
		const archive = this.archivePath(desktop.name)
		const started = now()
		const ref = { workspaceId: desktop.workspaceId, agentId: desktop.agentId }

		// Nothing else may hold the name or the ports: a restore needs both.
		await this.removeQuietly(desktop.name)
		releaseHostPort(desktop.hostPort)
		releaseHostPort(desktop.controlPort)
		try {
			// Ports are not part of a snapshot (live host connections are not captured),
			// so they are re-declared here, on the same host ports as before.
			await run(
				msb.msbBin,
				[
					'snapshot',
					'restore',
					archive,
					'--name',
					desktop.name,
					'-p',
					`${this.bridgeGateway}:${desktop.hostPort}:${DESKTOP_GUEST_PORT}`,
					'-p',
					`${this.bridgeGateway}:${desktop.controlPort}:${DESKTOP_CONTROL_GUEST_PORT}`,
					// The firewall is not part of a snapshot either, and a restore takes
					// the complete policy or none. Stated in full so the port block the
					// computer was created with still applies after every wake.
					...this.restoreNetworkArgs(desktop.relayBlockStart),
				],
				{ timeoutMs: DESKTOP_RESTORE_TIMEOUT_MS },
			)
			await this.waitUntilReady(desktop.controlPort, { sleep, now })
		} catch (err) {
			const e = err as { stderr?: unknown; message?: string }
			logger.error('workspace desktop restore failed, snapshot kept', {
				...ref,
				stderr: e.stderr ? String(e.stderr) : '',
				message: e.message ?? 'unknown',
			})
			// A half-restored VM must not linger holding the name and ports.
			await this.removeQuietly(desktop.name)
			return false
		}
		desktop.status = 'running'
		await this.persist()
		await this.removeArchive(desktop.name)
		logger.info('workspace desktop resumed', { ...ref, restoreMs: now() - started })
		return true
	}

	private archivePath(name: string): string {
		return join(this.deps.snapshots?.dir ?? '', `${name}.msb`)
	}

	private async archiveExists(name: string): Promise<boolean> {
		if (!this.deps.snapshots) return false
		try {
			return (await stat(this.archivePath(name))).isFile()
		} catch {
			return false
		}
	}

	private async removeArchive(name: string): Promise<void> {
		if (!this.deps.snapshots) return
		await rm(this.archivePath(name), { force: true })
	}

	// Deletes every archive in the snapshot directory that no suspended desktop in
	// the registry owns: leftovers from a removed desktop, a failed suspend, or
	// the one-desktop-per-workspace layout. Run after the registry is rebuilt.
	private async sweepOrphanArchives(): Promise<void> {
		const config = this.deps.snapshots
		if (!config) return
		let files: string[]
		try {
			files = await readdir(config.dir)
		} catch {
			return
		}
		const owned = new Set(
			[...this.desktops.values()]
				.filter((d) => d.status === 'suspended')
				.map((d) => `${d.name}.msb`),
		)
		for (const file of files) {
			if (!file.endsWith('.msb') || owned.has(file)) continue
			logger.warn('removing orphaned desktop snapshot archive', { file })
			await rm(join(config.dir, file), { force: true })
		}
	}

	private async provision(workspaceId: string, agentId: string): Promise<WorkspaceDesktop | null> {
		const { msb, image } = this.deps
		const name = desktopName(workspaceId, agentId)
		const ref = { workspaceId, agentId }
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
				...ref,
				error: String(err),
			})
			return null
		}
		const password = randomBytes(18).toString('base64url')
		const relayBlockStart = this.allocateRelayBlock()
		if (this.deps.relay && relayBlockStart === undefined) {
			logger.warn(
				'workspace desktop: no relay port block left, agent cannot expose dev servers',
				ref,
			)
		}

		const options = [
			'--name',
			name,
			'--memory',
			`${DESKTOP_MEMORY_MIB}M`,
			'--cpus',
			String(DESKTOP_CPUS),
			'--pull',
			'always',
			// Bridge-only publish of noVNC. Deliberately NO allow@private rule:
			// unlike the browser sidecar, nothing needs to reach other VMs from
			// here, and a desktop that can is a lateral-movement path.
			'-p',
			`${this.bridgeGateway}:${hostPort}:${DESKTOP_GUEST_PORT}`,
			'-p',
			`${this.bridgeGateway}:${controlPort}:${DESKTOP_CONTROL_GUEST_PORT}`,
			...this.createNetworkArgs(relayBlockStart),
			'-e',
			`VNC_PASSWORD=${password}`,
			image,
		]
		// With snapshots, the entrypoint must be the sandbox's own primary workload
		// (`msb run -d`). `msb create` + `msb exec` makes it a managed job, and msb
		// refuses a full snapshot while any job is active.
		const snapshotsOn = this.deps.snapshots !== undefined
		const createArgs = snapshotsOn ? ['run', '-d', ...options] : ['create', '--quiet', ...options]

		// msb create binds hostPort itself, so release our reservation first.
		releaseHostPort(hostPort)
		releaseHostPort(controlPort)
		try {
			await run(msb.msbBin, createArgs, { timeoutMs: DESKTOP_CREATE_TIMEOUT_MS })
			await waitForRunning(msb.msbBin, name, { run, sleep, now })
			if (!snapshotsOn) this.launchEntrypoint(name)
			// Not a TCP poll: msb's port forwarder accepts connections on the host
			// before anything listens in the guest, so a TCP connect succeeds at
			// once and a stream opened right after provisioning hangs. desktopd's
			// /healthz only answers 200 when X and noVNC are really up.
			await this.waitUntilReady(controlPort, { sleep, now })
		} catch (err) {
			const e = err as { stderr?: unknown; message?: string }
			logger.error('workspace desktop provision failed', {
				...ref,
				stderr: e.stderr ? String(e.stderr) : '',
				message: e.message ?? 'unknown',
			})
			await this.removeQuietly(name)
			return null
		}

		logger.info('workspace desktop started', { ...ref, name, hostPort, controlPort })
		return {
			workspaceId: workspaceId.toLowerCase(),
			agentId: agentId.toLowerCase(),
			name,
			hostPort,
			controlPort,
			password,
			status: 'running',
			...(relayBlockStart !== undefined && { relayBlockStart }),
		}
	}

	// The host-loopback ports this computer may reach, as an msb rule target.
	private relayRange(blockStart: number): string {
		const size = this.deps.relay?.blockSize ?? 1
		return size === 1 ? String(blockStart) : `${blockStart}-${blockStart + size - 1}`
	}

	// Rules in order (first match wins): the IPv6 host-alias deny must precede any
	// allow@host rule. The one allow@host:tcp rule covers ONLY this computer's own
	// block — never allow@private, which would open the whole msb bridge.
	private networkRules(blockStart?: number): string[] {
		return [
			DENY_HOST_ALIAS_IPV6_RESET_RULE,
			...(blockStart !== undefined && this.deps.relay
				? [`allow@host:tcp:${this.relayRange(blockStart)}`]
				: []),
			PUBLIC_EGRESS_RULE,
			DNS_UDP_RULE,
			DNS_TCP_RULE,
		]
	}

	private createNetworkArgs(blockStart?: number): string[] {
		return this.networkRules(blockStart).flatMap((rule) => ['--net-rule', rule])
	}

	// `msb snapshot restore` replaces the whole policy and needs a default. Egress
	// is denied by default exactly as on create, and ingress is allowed so the
	// published noVNC and control ports keep working (verified on msb 0.7.8).
	private restoreNetworkArgs(blockStart?: number): string[] {
		const rules = this.networkRules(blockStart).map((rule) =>
			rule === DENY_HOST_ALIAS_IPV6_RESET_RULE ? rule : rule.replace('@', ':egress@'),
		)
		return [
			'--net-default',
			'deny',
			'--net-rule',
			'allow:ingress@any',
			...rules.flatMap((rule) => ['--net-rule', rule]),
		]
	}

	// Lowest block no other computer holds, or undefined when relays are off or
	// the pool is used up.
	private allocateRelayBlock(): number | undefined {
		const relay = this.deps.relay
		if (!relay) return undefined
		const blocks = Math.floor((relay.portEnd - relay.portStart + 1) / relay.blockSize)
		const taken = new Set(
			[...this.desktops.values()].flatMap((d) =>
				d.relayBlockStart === undefined ? [] : [d.relayBlockStart],
			),
		)
		for (let i = 0; i < blocks; i++) {
			const start = relay.portStart + i * relay.blockSize
			if (!taken.has(start)) return start
		}
		return undefined
	}

	/**
	 * Opens (or returns the existing) tunnel from this agent's computer to a TCP
	 * port in one of the agent's running session sandboxes. The sandbox must be
	 * on this server; the caller (apps/dev) has already checked the session
	 * belongs to the agent. Idempotent per (session, guestPort). The relay port is
	 * chosen here from the computer's own block, never by the caller.
	 */
	async exposePort(
		workspaceId: string,
		agentId: string,
		sessionId: string,
		guestPort: number,
	): Promise<ExposePortResult> {
		const key = desktopKey(workspaceId, agentId)
		const desktop = this.desktops.get(key)
		const relayConfig = this.deps.relay
		if (!desktop) {
			return {
				ok: false,
				reason: 'no_desktop',
				message: 'This agent has no computer on this server.',
			}
		}
		if (!relayConfig || desktop.relayBlockStart === undefined) {
			return {
				ok: false,
				reason: 'no_relay_block',
				message:
					'This computer was created before port exposure existed, or no port block was free. It has to be recreated to expose ports.',
			}
		}
		const blockStart = desktop.relayBlockStart
		return this.enqueueRelay(key, async () => {
			const mine = this.relays.get(key) ?? new Map()
			for (const [relayPort, entry] of mine) {
				if (entry.sessionId === sessionId && entry.relay.targetGuestPort === guestPort) {
					return { ok: true as const, port: { guestPort, relayPort, sessionId } }
				}
			}
			let relayPort: number | undefined
			for (let i = 0; i < relayConfig.blockSize; i++) {
				const candidate = blockStart + i
				if (mine.has(candidate)) continue
				// Bound and held so a concurrent expose can't take it; also skips a port
				// something else on the host already listens on.
				if (await reserveHostPort('127.0.0.1', candidate)) {
					relayPort = candidate
					break
				}
			}
			if (relayPort === undefined) {
				return {
					ok: false as const,
					reason: 'too_many_ports' as const,
					message: `All ${relayConfig.blockSize} ports for this computer are in use. Close one first.`,
				}
			}
			const started = await startSshRelay(
				sessionId,
				guestPort,
				relayPort,
				relayConfig.sshKeyPath,
				this.deps.msb,
			)
			if (!started.ok) {
				const sandbox = await sandboxState(sessionId, this.deps.msb)
				logger.error('workspace desktop: tunnel could not be opened', {
					workspaceId,
					agentId,
					sessionId,
					guestPort,
					relayPort,
					step: started.step,
					detail: started.detail,
					sandbox,
				})
				return {
					ok: false as const,
					reason: 'relay_failed' as const,
					message: `The tunnel could not be opened. ${started.detail} Session sandbox: ${sandbox}.`,
				}
			}
			const { relay } = started
			mine.set(relayPort, { relay, sessionId })
			this.relays.set(key, mine)
			return { ok: true as const, port: { guestPort, relayPort, sessionId } }
		})
	}

	/** Tunnels currently open for one computer. */
	listPorts(workspaceId: string, agentId: string): ExposedPort[] {
		const mine = this.relays.get(desktopKey(workspaceId, agentId))
		if (!mine) return []
		return [...mine.entries()].map(([relayPort, e]) => ({
			guestPort: e.relay.targetGuestPort,
			relayPort,
			sessionId: e.sessionId,
		}))
	}

	/** Closes one tunnel by its relay port. Returns whether there was one. */
	closePort(workspaceId: string, agentId: string, relayPort: number): boolean {
		const key = desktopKey(workspaceId, agentId)
		const entry = this.relays.get(key)?.get(relayPort)
		if (!entry) return false
		entry.relay.stop()
		this.relays.get(key)?.delete(relayPort)
		return true
	}

	/** A session ended: its sandbox is gone, so every tunnel into it is dead weight. */
	closeSessionRelays(sessionId: string): void {
		for (const [key, mine] of this.relays) {
			for (const [relayPort, entry] of mine) {
				if (entry.sessionId !== sessionId) continue
				entry.relay.stop()
				mine.delete(relayPort)
			}
			if (mine.size === 0) this.relays.delete(key)
		}
	}

	private stopAllRelays(key: string): void {
		for (const entry of this.relays.get(key)?.values() ?? []) entry.relay.stop()
		this.relays.delete(key)
	}

	// Exposes for one computer run one at a time, so two calls can't both pick the
	// same free port. Separate from the lifecycle queue: opening a tunnel must not
	// wait behind a multi-second suspend or wake.
	private readonly relayQueues = new Map<string, Promise<unknown>>()
	private enqueueRelay<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.relayQueues.get(key) ?? Promise.resolve()
		const run = previous.then(fn, fn)
		const tail = run.catch(() => undefined)
		this.relayQueues.set(key, tail)
		tail.then(() => {
			if (this.relayQueues.get(key) === tail) this.relayQueues.delete(key)
		})
		return run
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
	 * such desktop. A suspended desktop is woken first. Authenticates with the
	 * desktop's own password, which never leaves this process.
	 */
	async control(
		workspaceId: string,
		agentId: string,
		path: '/screenshot' | '/input' | '/exec',
		body: unknown,
	): Promise<{ status: number; body: unknown } | null> {
		let desktop = this.get(workspaceId, agentId)
		if (!desktop) return null
		if (desktop.status === 'suspended') {
			const woke = await this.ensure(workspaceId, agentId)
			if (!woke) throw new Error('desktop could not be resumed')
			desktop = woke
		}
		// Touched before AND after: a long /exec must not be suspended from under
		// itself, and the idle clock should start when the call finished.
		this.touch(workspaceId, agentId)
		const doFetch = this.deps.fetchImpl ?? fetch
		try {
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
		} finally {
			this.touch(workspaceId, agentId)
		}
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
		let raw: string
		try {
			raw = await readFile(this.deps.stateFile, 'utf8')
		} catch (err) {
			// No file is a first boot. Anything else (EACCES, EIO) is not "no state":
			// reconcile would read it as "every desktop is unknown" and remove them all.
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
			logger.error('workspace desktop state unreadable, leaving desktops untouched', {
				error: String(err),
			})
			throw err
		}
		try {
			const parsed: unknown = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('state file is not an object')
			}
			return parsed as Record<string, PersistedDesktop>
		} catch (err) {
			// Corrupt state (a torn write, a bad edit). Keep the evidence and refuse
			// to reconcile: treating it as empty would remove every VM and delete the
			// snapshot archives of suspended desktops, which are the only copy.
			const aside = `${this.deps.stateFile}.corrupt-${this.now()}`
			await rename(this.deps.stateFile, aside).catch((renameErr) =>
				logger.error('could not move corrupt workspace desktop state aside', {
					error: String(renameErr),
				}),
			)
			logger.error('workspace desktop state is corrupt, leaving desktops untouched', {
				error: String(err),
				movedTo: aside,
			})
			throw err
		}
	}

	private async persist(): Promise<void> {
		const state: Record<string, PersistedDesktop> = {}
		for (const [key, d] of this.desktops) {
			state[key] = {
				hostPort: d.hostPort,
				controlPort: d.controlPort,
				password: d.password,
				status: d.status,
				...(d.relayBlockStart !== undefined && { relayBlockStart: d.relayBlockStart }),
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

const STREAM_PATH_RE =
	/^\/desktops\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stream$/i

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
 * Handles `GET /desktops/:workspaceId/:agentId/stream` WebSocket upgrades by
 * splicing the client socket onto the desktop's noVNC (websockify) port at the
 * TCP level. No WebSocket library is needed: we authenticate the upgrade request,
 * replay it to websockify, and then pipe bytes both ways, so websockify does
 * the actual WebSocket handshake and framing.
 *
 * Authentication is the same shared bearer as every other /sessions-style
 * route — apps/dev is the only caller; browsers never reach this server.
 *
 * A suspended desktop is woken before the splice, and the open stream counts as
 * a viewer so the desktop is never suspended from under someone watching it.
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
	const workspaceId = match[1] as string
	const agentId = match[2] as string
	const known = deps.registry.get(workspaceId, agentId)
	if (!known) {
		rejectUpgrade(socket, 404, 'Not Found')
		return
	}

	const splice = (desktop: WorkspaceDesktop): void => {
		const upstream = connect({ host: deps.registry.gateway, port: desktop.hostPort })
		let counted = false
		const teardown = (): void => {
			socket.destroy()
			upstream.destroy()
			if (counted) {
				counted = false
				deps.registry.viewerClosed(desktop.workspaceId, desktop.agentId)
			}
		}
		upstream.on('error', (err) => {
			logger.warn('workspace desktop stream upstream error', {
				workspaceId: desktop.workspaceId,
				agentId: desktop.agentId,
				error: String(err),
			})
			teardown()
		})
		socket.on('error', teardown)
		socket.on('close', teardown)
		upstream.on('close', teardown)

		upstream.on('connect', () => {
			counted = true
			deps.registry.viewerOpened(desktop.workspaceId, desktop.agentId)
			// Replay the handshake to websockify, minus our bearer, pointed at its
			// own path and host.
			const lines = [
				'GET /websockify HTTP/1.1',
				`Host: ${deps.registry.gateway}:${desktop.hostPort}`,
			]
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

	if (known.status !== 'suspended') {
		splice(known)
		return
	}
	deps.registry
		.ensure(workspaceId, agentId)
		.then((desktop) => {
			if (socket.destroyed) return
			if (!desktop) {
				rejectUpgrade(socket, 502, 'Bad Gateway')
				return
			}
			splice(desktop)
		})
		.catch((err) => {
			logger.warn('workspace desktop wake for stream failed', {
				workspaceId,
				agentId,
				error: String(err),
			})
			if (!socket.destroyed) rejectUpgrade(socket, 502, 'Bad Gateway')
		})
}
