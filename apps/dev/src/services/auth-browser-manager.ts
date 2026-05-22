import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { authBrowserSessions } from '@maskin/db/schema'
import { and, eq, inArray, lt, or } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { ContainerManager } from './container-manager'

/** Hard upper bound on browser lifetime regardless of activity. */
const HARD_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
/** Tighter TTL while the row is in `starting`/`ready` (i.e. the connect modal phase). */
const CONNECT_TTL_MS = 10 * 60 * 1000 // 10 minutes
/** Kill an idle browser after this many ms of no activity. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
/** Watchdog cadence. */
const WATCHDOG_INTERVAL_MS = 60_000
/** Image tag built lazily from `docker/auth-browser/`. */
const IMAGE = 'maskin-auth-browser:latest'
/** How long the readiness probe will wait for Chromium's /json/version to respond. */
const STARTUP_PROBE_TIMEOUT_MS = 30_000
/** Interval between probe attempts. */
const STARTUP_PROBE_INTERVAL_MS = 250
/** Poll cadence for waitForReady. */
const READY_POLL_MS = 250
/** Host CDP probes connect to. We use 127.0.0.1 explicitly instead of 'localhost'
 *  because Node 18+ resolves 'localhost' to IPv6 (::1) first, and Docker Desktop
 *  only binds published ports on IPv4 — yielding "socket hang up" rather than
 *  ECONNREFUSED. */
const CDP_HOST = '127.0.0.1'

export type AuthBrowserStatus = 'starting' | 'ready' | 'idle' | 'driving' | 'failed' | 'expired'

export interface StartParams {
	workspaceId: string
	actorId: string
	provider: string
}

export interface StartResult {
	id: string
	accessToken: string
	expiresAt: Date
	/** True if the response is reattaching to an existing logged-in browser
	 *  (no new container was provisioned). */
	reattached: boolean
}

export interface ClaimResult {
	id: string
	host: string
	port: number
}

/**
 * Per-workspace, per-provider browser lifecycle. A single Chromium container
 * is provisioned on first login, kept alive past cookie capture, and shared
 * between the connect modal and agent sessions over CDP.
 *
 * States:
 *   starting → ready          (provision complete)
 *   ready    → idle           (cookies captured; modal closes)
 *   idle     → driving        (agent claims for exclusive use)
 *   driving  → idle           (agent releases on session end)
 *   any      → failed|expired (error / idle-reap / hard TTL)
 */
export class AuthBrowserManager {
	private containers: ContainerManager
	private watchdogInterval: NodeJS.Timeout | null = null
	private buildContext: string | null = null

	constructor(private db: Database) {
		this.containers = new ContainerManager()
	}

	/** Build-context for the auth-browser image. Resolved at boot in index.ts. */
	setBuildContext(buildContext: string) {
		this.buildContext = buildContext
	}

	async start(): Promise<void> {
		// Reconcile any rows left in an active state by a previous backend.
		await this.reconcile().catch((err) =>
			logger.error('AuthBrowserManager reconcile failed', { error: String(err) }),
		)

		this.watchdogInterval = setInterval(() => {
			this.reapStale().catch((err) =>
				logger.error('AuthBrowserManager reaper failed', { error: String(err) }),
			)
		}, WATCHDOG_INTERVAL_MS)
	}

	async stop(): Promise<void> {
		if (this.watchdogInterval) {
			clearInterval(this.watchdogInterval)
			this.watchdogInterval = null
		}
	}

	/**
	 * Provision (or reattach to) a workspace browser for the given provider.
	 *
	 * - If a `ready`/`idle` row already exists, returns its id + access token
	 *   (no new container, no new credentials). The modal opens directly onto
	 *   the existing logged-in Chromium.
	 * - If a `driving` row exists, refuses — the modal can't grab a browser the
	 *   agent is currently driving.
	 * - Otherwise, inserts a fresh `starting` row and provisions in the background.
	 */
	async startSession(params: StartParams): Promise<StartResult> {
		// Look for a reusable browser first. ready = post-provision but no cookies
		// yet; idle = cookies captured, no driver. Both are reattach-able.
		const reusable = await this.findReusable(params.workspaceId, params.provider)
		if (reusable) {
			await this.touchActivity(reusable.id)
			return {
				id: reusable.id,
				accessToken: reusable.accessToken,
				expiresAt: reusable.expiresAt,
				reattached: true,
			}
		}

		// If an agent is driving, refuse. The unique index will also catch this,
		// but an explicit check yields a clearer error.
		const busy = await this.db
			.select({ id: authBrowserSessions.id })
			.from(authBrowserSessions)
			.where(
				and(
					eq(authBrowserSessions.workspaceId, params.workspaceId),
					eq(authBrowserSessions.provider, params.provider),
					eq(authBrowserSessions.status, 'driving'),
				),
			)
			.limit(1)
		if (busy.length > 0) {
			throw new Error(
				'An agent session is currently using this browser. Stop the agent first, then reopen the connect modal.',
			)
		}

		const accessToken = randomUUID()
		const expiresAt = new Date(Date.now() + CONNECT_TTL_MS)

		let row: { id: string } | undefined
		try {
			const inserted = await this.db
				.insert(authBrowserSessions)
				.values({
					workspaceId: params.workspaceId,
					actorId: params.actorId,
					provider: params.provider,
					status: 'starting',
					accessToken,
					expiresAt,
				})
				.returning()
			row = inserted[0]
		} catch (err) {
			// Defense in depth against TOCTOU on the SELECT above (e.g. React StrictMode
			// double-mount firing two POSTs in parallel). The partial unique index
			// rejects the second insert; treat that as a reattach by re-querying.
			if (isUniqueViolation(err)) {
				const reuseRetry = await this.findReusable(params.workspaceId, params.provider)
				if (reuseRetry) {
					await this.touchActivity(reuseRetry.id)
					return {
						id: reuseRetry.id,
						accessToken: reuseRetry.accessToken,
						expiresAt: reuseRetry.expiresAt,
						reattached: true,
					}
				}
				throw new Error(
					'Another connect flow is already running in this workspace. Cancel it or wait for it to expire.',
				)
			}
			throw err
		}
		if (!row) throw new Error('Failed to insert auth_browser_sessions row')

		void this.provisionContainer(row.id).catch((err) =>
			logger.error('Auth browser provision failed', { id: row.id, error: String(err) }),
		)

		return { id: row.id, accessToken, expiresAt, reattached: false }
	}

	/** Find a row that can be reattached by the modal: ready or idle, not expired. */
	private async findReusable(workspaceId: string, provider: string) {
		const [row] = await this.db
			.select()
			.from(authBrowserSessions)
			.where(
				and(
					eq(authBrowserSessions.workspaceId, workspaceId),
					eq(authBrowserSessions.provider, provider),
					inArray(authBrowserSessions.status, ['ready', 'idle']),
				),
			)
			.limit(1)
		if (!row) return null
		if (row.expiresAt.getTime() < Date.now()) return null
		return row
	}

	/**
	 * Block until the row flips to 'ready' OR 'idle' (both are usable by the
	 * modal). Returns null on token mismatch / failure / timeout.
	 */
	async waitForReady(
		id: string,
		accessToken: string,
		timeoutMs: number,
	): Promise<{ host: string; port: number } | null> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const [row] = await this.db
				.select()
				.from(authBrowserSessions)
				.where(eq(authBrowserSessions.id, id))
				.limit(1)
			if (!row || row.accessToken !== accessToken) return null
			if (row.status === 'failed' || row.status === 'expired') return null
			if (row.status === 'driving') {
				// An agent already claimed it — modal can't drive concurrently.
				return null
			}
			if (row.status === 'ready' || row.status === 'idle') {
				const endpoint = await this.endpointForRow(row)
				if (endpoint) return endpoint
			}
			await new Promise((r) => setTimeout(r, READY_POLL_MS))
		}
		return null
	}

	private async provisionContainer(id: string): Promise<void> {
		const prefix = id.slice(0, 8)
		const networkName = `anko-auth-net-${prefix}`
		const containerName = `anko-auth-browser-${prefix}`
		let containerId: string | undefined

		try {
			if (this.buildContext) {
				await this.containers.ensureImage(IMAGE, this.buildContext)
			}
			await this.containers.createNetwork(networkName)

			containerId = await this.containers.create({
				image: IMAGE,
				name: containerName,
				env: {},
				memoryMb: 1024,
				cpuShares: 1024,
				binds: [],
				networkMode: networkName,
				portBindings: { '9222/tcp': '' },
			})

			await this.containers.start(containerId)

			const port = await this.containers.getPublishedPort(containerId, '9222/tcp')
			if (!port) throw new Error('CDP port was not published')
			await probeCdpReady(port, STARTUP_PROBE_TIMEOUT_MS)

			await this.db
				.update(authBrowserSessions)
				.set({
					status: 'ready',
					containerId,
					networkName,
					updatedAt: new Date(),
					lastActivityAt: new Date(),
				})
				.where(eq(authBrowserSessions.id, id))

			logger.info('Auth browser session ready', { id, containerName, networkName })
		} catch (err) {
			logger.error('Auth browser provisioning failed', { id, error: String(err) })
			await this.db
				.update(authBrowserSessions)
				.set({
					status: 'failed',
					error: err instanceof Error ? err.message : String(err),
					updatedAt: new Date(),
				})
				.where(eq(authBrowserSessions.id, id))

			if (containerId) {
				await this.containers.stop(containerId).catch(() => {})
				await this.containers.remove(containerId).catch(() => {})
			}
			await this.containers.removeNetwork(networkName).catch(() => {})
		}
	}

	/**
	 * Return localhost host + port for the container's published CDP, or null
	 * if the session isn't usable. Used by the CDP stream proxy and agent
	 * claim path to open a chrome-remote-interface client.
	 */
	async getCdpEndpoint(
		id: string,
		accessToken: string,
	): Promise<{ host: string; port: number } | null> {
		const [row] = await this.db
			.select()
			.from(authBrowserSessions)
			.where(eq(authBrowserSessions.id, id))
			.limit(1)
		if (!row || row.accessToken !== accessToken) return null
		// 'driving' is excluded — only the holding agent can talk to it.
		if (row.status !== 'ready' && row.status !== 'idle') return null
		return this.endpointForRow(row)
	}

	private async endpointForRow(row: {
		expiresAt: Date
		containerId: string | null
	}): Promise<{ host: string; port: number } | null> {
		if (row.expiresAt.getTime() < Date.now()) return null
		if (!row.containerId) return null
		const port = await this.containers.getPublishedPort(row.containerId, '9222/tcp')
		if (!port) return null
		return { host: CDP_HOST, port }
	}

	/**
	 * Mark cookies captured and transition the row to `idle`. The container
	 * keeps running so the modal can re-open it for re-login and agents can
	 * claim it for browser automation. The hard TTL is bumped to give idle
	 * browsers room to live; the idle reaper kills them on inactivity.
	 */
	async markCaptured(id: string, encryptedCredentials: string): Promise<void> {
		await this.db
			.update(authBrowserSessions)
			.set({
				status: 'idle',
				capturedCredentials: encryptedCredentials,
				expiresAt: new Date(Date.now() + HARD_TTL_MS),
				lastActivityAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(authBrowserSessions.id, id))
	}

	/**
	 * Atomically claim an idle workspace browser for an agent session.
	 * Returns the CDP endpoint + the row id (so the caller can release later).
	 *
	 * Returns null if no idle browser exists for the workspace, or if a
	 * concurrent claim won the race.
	 */
	async claimForAgent(
		workspaceId: string,
		provider: string,
		sessionId: string,
	): Promise<ClaimResult | null> {
		// CAS: only the row that's currently 'idle' transitions to 'driving'.
		// Drizzle's update returns the updated rows when .returning() is set.
		const [row] = await this.db
			.update(authBrowserSessions)
			.set({
				status: 'driving',
				claimedBySessionId: sessionId,
				lastActivityAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(authBrowserSessions.workspaceId, workspaceId),
					eq(authBrowserSessions.provider, provider),
					eq(authBrowserSessions.status, 'idle'),
				),
			)
			.returning()
		if (!row) return null

		const endpoint = await this.endpointForRow(row)
		if (!endpoint) {
			// Container is gone / port not published. Roll back and let the
			// caller fall back to a per-session sidecar.
			await this.db
				.update(authBrowserSessions)
				.set({
					status: 'failed',
					claimedBySessionId: null,
					error: 'Container disappeared between claim and endpoint resolve',
					updatedAt: new Date(),
				})
				.where(eq(authBrowserSessions.id, row.id))
			return null
		}

		logger.info('Workspace browser claimed by agent', {
			id: row.id,
			sessionId,
			workspaceId,
			provider,
		})
		return { id: row.id, host: endpoint.host, port: endpoint.port }
	}

	/**
	 * Release a claimed browser back to idle. Safe to call multiple times.
	 */
	async releaseFromAgent(id: string): Promise<void> {
		await this.db
			.update(authBrowserSessions)
			.set({
				status: 'idle',
				claimedBySessionId: null,
				lastActivityAt: new Date(),
				updatedAt: new Date(),
			})
			.where(and(eq(authBrowserSessions.id, id), eq(authBrowserSessions.status, 'driving')))
		logger.info('Workspace browser released to idle', { id })
	}

	private async touchActivity(id: string): Promise<void> {
		await this.db
			.update(authBrowserSessions)
			.set({ lastActivityAt: new Date(), updatedAt: new Date() })
			.where(eq(authBrowserSessions.id, id))
	}

	/**
	 * Tear down a session's container + network. Idempotent. Used by the
	 * /cancel route and by the reaper.
	 */
	async stopSession(id: string): Promise<void> {
		const [row] = await this.db
			.select()
			.from(authBrowserSessions)
			.where(eq(authBrowserSessions.id, id))
			.limit(1)
		if (!row) return

		if (row.containerId) {
			await this.containers.stop(row.containerId).catch(() => {})
			await this.containers.remove(row.containerId).catch(() => {})
		}
		if (row.networkName) {
			await this.containers.removeNetwork(row.networkName).catch(() => {})
		}

		// 'idle'/'driving' explicit cancellation → failed. Otherwise keep the
		// terminal status the row already has.
		const isActive =
			row.status === 'starting' ||
			row.status === 'ready' ||
			row.status === 'idle' ||
			row.status === 'driving'
		await this.db
			.update(authBrowserSessions)
			.set({
				status: isActive ? 'failed' : row.status,
				containerId: null,
				networkName: null,
				claimedBySessionId: null,
				updatedAt: new Date(),
			})
			.where(eq(authBrowserSessions.id, id))
	}

	/**
	 * Reap browsers that have outlived their usefulness:
	 *   - Past hard TTL (`expires_at < now`)
	 *   - Idle longer than IDLE_TIMEOUT_MS (`last_activity_at < threshold`)
	 *
	 * 'driving' rows are protected — an agent still owns them.
	 */
	async reapStale(): Promise<void> {
		const now = new Date()
		const idleThreshold = new Date(Date.now() - IDLE_TIMEOUT_MS)

		const stale = await this.db
			.select()
			.from(authBrowserSessions)
			.where(
				and(
					inArray(authBrowserSessions.status, ['starting', 'ready', 'idle']),
					or(
						lt(authBrowserSessions.expiresAt, now),
						and(
							eq(authBrowserSessions.status, 'idle'),
							lt(authBrowserSessions.lastActivityAt, idleThreshold),
						),
					),
				),
			)

		for (const row of stale) {
			logger.info('Reaping workspace browser', {
				id: row.id,
				status: row.status,
				lastActivityAt: row.lastActivityAt?.toISOString(),
				expiresAt: row.expiresAt.toISOString(),
			})
			if (row.containerId) {
				await this.containers.stop(row.containerId).catch(() => {})
				await this.containers.remove(row.containerId).catch(() => {})
			}
			if (row.networkName) {
				await this.containers.removeNetwork(row.networkName).catch(() => {})
			}
			await this.db
				.update(authBrowserSessions)
				.set({
					status: 'expired',
					containerId: null,
					networkName: null,
					claimedBySessionId: null,
					updatedAt: new Date(),
				})
				.where(eq(authBrowserSessions.id, row.id))
		}
	}

	/**
	 * Boot-time reconciliation: any active-state row whose container has
	 * vanished gets marked 'failed'. 'driving' rows also reset (the owning
	 * agent session is gone if the backend restarted).
	 */
	private async reconcile(): Promise<void> {
		const candidates = await this.db
			.select()
			.from(authBrowserSessions)
			.where(inArray(authBrowserSessions.status, ['starting', 'ready', 'idle', 'driving']))

		for (const row of candidates) {
			let alive = false
			if (row.containerId) {
				try {
					const status = await this.containers.inspect(row.containerId)
					alive = status.running
				} catch {
					alive = false
				}
			}

			if (!alive) {
				await this.db
					.update(authBrowserSessions)
					.set({
						status: 'failed',
						error: 'Container missing after backend restart',
						claimedBySessionId: null,
						updatedAt: new Date(),
					})
					.where(eq(authBrowserSessions.id, row.id))
				if (row.networkName) {
					await this.containers.removeNetwork(row.networkName).catch(() => {})
				}
			} else if (row.status === 'driving') {
				// Container is alive but the owning agent session is gone after
				// restart; demote to idle so the next claim can succeed.
				await this.db
					.update(authBrowserSessions)
					.set({
						status: 'idle',
						claimedBySessionId: null,
						lastActivityAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(authBrowserSessions.id, row.id))
				logger.info('Recovered driving→idle after backend restart', { id: row.id })
			}
		}
	}
}

// Postgres unique-violation SQLSTATE; lets us recognize the partial unique index
// firing without depending on a pg-specific client type at this layer.
function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

/**
 * Hit Chromium's HTTP /json/version endpoint until it returns 200 or we time
 * out. Logs the discovered webSocketDebuggerUrl on success.
 */
async function probeCdpReady(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://${CDP_HOST}:${port}/json/version`, {
				signal: AbortSignal.timeout(2000),
			})
			if (res.ok) {
				const body = (await res.json().catch(() => null)) as {
					webSocketDebuggerUrl?: string
					Browser?: string
				} | null
				logger.info('CDP ready', {
					port,
					browser: body?.Browser,
					wsUrl: body?.webSocketDebuggerUrl,
				})
				return
			}
			lastError = new Error(`/json/version returned ${res.status}`)
		} catch (err) {
			lastError = err
		}
		await new Promise((r) => setTimeout(r, STARTUP_PROBE_INTERVAL_MS))
	}
	throw new Error(
		`CDP never became reachable on ${CDP_HOST}:${port} (last error: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		})`,
	)
}
