import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { authBrowserSessions } from '@maskin/db/schema'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { ContainerManager } from './container-manager'

/** Time a session can live before the reaper kills it. */
const TTL_MS = 10 * 60 * 1000
/** Reaper cadence. */
const WATCHDOG_INTERVAL_MS = 60_000
/** Image tag built lazily from `docker/auth-browser/`. */
const IMAGE = 'maskin-auth-browser:latest'
/** Wait this long after container start before flipping to 'ready'. Xvfb + Chromium take a moment. */
const STARTUP_GRACE_MS = 4000
/** Poll cadence for waitForReady. */
const READY_POLL_MS = 250

export type AuthBrowserStatus = 'starting' | 'ready' | 'captured' | 'failed' | 'expired'

export interface StartParams {
	workspaceId: string
	actorId: string
	provider: string
}

export interface StartResult {
	id: string
	accessToken: string
	expiresAt: Date
}

/**
 * Lightweight standalone lifecycle for short-lived headful Chromium containers.
 * Used for provider connect flows (currently LinkedIn) that need an interactive
 * login the user can drive, with cookies captured server-side via CDP.
 *
 * Parallel to SessionManager but intentionally decoupled — these are not agent
 * sessions, have no logs, and live ~10 minutes max.
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
		// Reconcile any rows left "starting"/"ready" by a previous backend that
		// died without cleanup. Containers/networks are reaped if missing.
		await this.reconcile().catch((err) =>
			logger.error('AuthBrowserManager reconcile failed', { error: String(err) }),
		)

		this.watchdogInterval = setInterval(() => {
			this.reapExpired().catch((err) =>
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
	 * Provision a new headful Chromium container and return the SSE/input access
	 * token. Throws if another flow is already running in this workspace.
	 * Container provisioning runs out-of-band; status flips to 'ready' (or
	 * 'failed') asynchronously — callers poll the row or wait for SSE.
	 */
	async startSession(params: StartParams): Promise<StartResult> {
		const existing = await this.db
			.select({ id: authBrowserSessions.id })
			.from(authBrowserSessions)
			.where(
				and(
					eq(authBrowserSessions.workspaceId, params.workspaceId),
					inArray(authBrowserSessions.status, ['starting', 'ready']),
				),
			)
			.limit(1)
		if (existing.length > 0) {
			throw new Error(
				'Another connect flow is already running in this workspace. Cancel it or wait for it to expire.',
			)
		}

		const accessToken = randomUUID()
		const expiresAt = new Date(Date.now() + TTL_MS)

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
			// `auth_browser_sessions_ws_active_uniq` rejects the second insert.
			if (isUniqueViolation(err)) {
				throw new Error(
					'Another connect flow is already running in this workspace. Cancel it or wait for it to expire.',
				)
			}
			throw err
		}
		if (!row) throw new Error('Failed to insert auth_browser_sessions row')

		// Provision async — surface errors via row status, not via the API
		void this.provisionContainer(row.id).catch((err) =>
			logger.error('Auth browser provision failed', { id: row.id, error: String(err) }),
		)

		return { id: row.id, accessToken, expiresAt }
	}

	/**
	 * Block until the row flips to 'ready' (resolves the same { host, port } that
	 * `getCdpEndpoint` would). Returns null on token mismatch / failure / timeout
	 * so the caller can 400 cleanly.
	 *
	 * The provisioning path is fire-and-forget from `startSession`, so the SSE/
	 * input route can't assume the container is already up when the frontend
	 * opens it. This helper bridges that gap without blocking `/start`.
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
			if (row.status === 'failed' || row.status === 'expired' || row.status === 'captured') {
				return null
			}
			if (row.status === 'ready') {
				// Row is ready, but the published port may not yet be visible to
				// Docker. Treat null as transient and keep polling.
				const endpoint = await this.getCdpEndpoint(id, accessToken)
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
				// Publish CDP to an ephemeral host port so the backend (on host)
				// can talk to chrome-remote-interface without being on the network.
				portBindings: { '9222/tcp': '' },
			})

			await this.containers.start(containerId)
			await new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_MS))

			await this.db
				.update(authBrowserSessions)
				.set({ status: 'ready', containerId, networkName, updatedAt: new Date() })
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
	 * if the session isn't usable. Used by the CDP stream proxy (Module C) to
	 * open a chrome-remote-interface client.
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
		if (!row || row.accessToken !== accessToken || row.status !== 'ready') return null
		if (row.expiresAt.getTime() < Date.now()) return null
		if (!row.containerId) return null
		const port = await this.containers.getPublishedPort(row.containerId, '9222/tcp')
		if (!port) return null
		return { host: 'localhost', port }
	}

	/**
	 * Tear down a session's container + network. Idempotent.
	 * Sets status='failed' if not already 'captured'.
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

		const finalStatus: AuthBrowserStatus = row.status === 'captured' ? 'captured' : 'failed'
		await this.db
			.update(authBrowserSessions)
			.set({
				status: finalStatus,
				containerId: null,
				networkName: null,
				updatedAt: new Date(),
			})
			.where(eq(authBrowserSessions.id, id))
	}

	/**
	 * Mark a session as having captured credentials (encrypted JSON blob).
	 * Tears down the container as a side effect.
	 */
	async markCaptured(id: string, encryptedCredentials: string): Promise<void> {
		await this.db
			.update(authBrowserSessions)
			.set({
				status: 'captured',
				capturedCredentials: encryptedCredentials,
				updatedAt: new Date(),
			})
			.where(eq(authBrowserSessions.id, id))
		await this.stopSession(id)
	}

	/**
	 * Reap any session whose expires_at has passed and is still alive.
	 * Containers + networks get cleaned, row flips to 'expired'.
	 */
	async reapExpired(): Promise<void> {
		const now = new Date()
		const expired = await this.db
			.select()
			.from(authBrowserSessions)
			.where(
				and(
					inArray(authBrowserSessions.status, ['starting', 'ready']),
					lt(authBrowserSessions.expiresAt, now),
				),
			)

		for (const row of expired) {
			logger.info('Reaping expired auth browser session', { id: row.id })
			if (row.containerId) {
				await this.containers.stop(row.containerId).catch(() => {})
				await this.containers.remove(row.containerId).catch(() => {})
			}
			if (row.networkName) {
				await this.containers.removeNetwork(row.networkName).catch(() => {})
			}
			await this.db
				.update(authBrowserSessions)
				.set({ status: 'expired', updatedAt: new Date() })
				.where(eq(authBrowserSessions.id, row.id))
		}
	}

	/**
	 * Boot-time reconciliation: any 'starting'/'ready' row whose container has
	 * vanished (e.g. backend died between provision and cleanup) gets marked
	 * 'failed' so the UI doesn't show ghost connect flows.
	 */
	private async reconcile(): Promise<void> {
		const candidates = await this.db
			.select()
			.from(authBrowserSessions)
			.where(inArray(authBrowserSessions.status, ['starting', 'ready']))

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
						updatedAt: new Date(),
					})
					.where(eq(authBrowserSessions.id, row.id))
				if (row.networkName) {
					await this.containers.removeNetwork(row.networkName).catch(() => {})
				}
			}
		}
	}
}

// Postgres unique-violation SQLSTATE; lets us recognize the partial unique index
// firing without depending on a pg-specific client type at this layer.
function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
