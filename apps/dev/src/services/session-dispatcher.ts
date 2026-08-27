import type { Database } from '@maskin/db'
import { events, agentServers, sessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { LlmCredentialsUnavailableError } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import {
	AgentServerAuthError,
	AgentServerClient,
	type AgentServerRow,
	type StartSessionRequest,
} from './agent-server-client'
import type { DispatchResult } from './session-dispatch-queue'

/**
 * Routes a session-start over HTTPS to the least-loaded `active`
 * `agent_servers` row. The dispatcher is the `DispatchFn` the T12 queue calls
 * when a row becomes ready — it does not poll the queue itself.
 *
 * Load is `count(sessions WHERE agent_server_id = $ AND status IN
 * ('starting','running')) / max_concurrent_sessions`. Rows already at or above
 * capacity are excluded; if the candidate set is empty the dispatcher returns
 * `no_capacity` so the queue parks the row at its backoff.
 *
 * The session row's `agent_server_id` is set BEFORE the POST so any concurrent
 * dispatcher sees the slot consumed when computing load. If the POST fails the
 * field is rolled back, freeing the slot before the queue retries.
 *
 * If a dispatch attempt is interrupted after claiming a slot but before it
 * either completes or rolls back (e.g. the process is killed mid-dispatch by
 * a deploy), the session is left pinned to that server. A retry MUST target
 * the same server it's already pinned to — `dispatch()` checks for this via
 * `getStickyAssignment()` before falling back to `pickLeastLoadedServer()`.
 * Without this, a retry that picks a different (now less-loaded) server would
 * have its claim rejected by `claimSlot`'s same-server check and be wrongly
 * reported as a `permanent_failure`, discarding a session that was likely
 * still recoverable. See MASKIN-DEV-6.
 */

export type StartSessionRequestBuilder = (sessionId: string) => Promise<StartSessionRequest | null>

export type AgentServerClientFactory = (server: AgentServerRow) => AgentServerClient

/**
 * Delivers a session's opening turn once it's dispatched. Mirrors the
 * local-Docker `launchContainer()` path in session-manager.ts, which calls
 * `writeInput()` right after `attachStdin()` — interactive sessions have no
 * `ACTION_PROMPT` env var (see buildLaunchSpec), so `agent-run.sh`'s
 * interactive branch blocks forever reading `claude`'s stdin from
 * `/sessions/:id/input/stream` until something POSTs `/sessions/:id/input`.
 * No-ops for non-interactive sessions (their prompt already went in via env).
 */
export type SeedInteractiveTurnFn = (sessionId: string) => Promise<void>

export interface SessionDispatcherDeps {
	db: Database
	/**
	 * Builds the `StartSessionRequest` (image, env, memory, cpus) for a session.
	 * Returns `null` when the session row vanished or is no longer in a
	 * dispatchable state — the dispatcher treats that as a permanent failure
	 * so the queue stops retrying a session that can't be built.
	 */
	buildStartRequest: StartSessionRequestBuilder
	/** Constructs an `AgentServerClient` for a chosen server row. */
	clientFactory?: AgentServerClientFactory
	/** See `SeedInteractiveTurnFn`. Optional so tests that don't exercise interactive dispatch can omit it. */
	seedInteractiveTurn?: SeedInteractiveTurnFn
}

export interface PickedServer {
	server: { id: string; url: string }
	active: number
	max: number
}

export class SessionDispatcher {
	private readonly db: Database
	private readonly buildStartRequest: StartSessionRequestBuilder
	private readonly clientFactory: AgentServerClientFactory
	private readonly seedInteractiveTurn?: SeedInteractiveTurnFn

	constructor(deps: SessionDispatcherDeps) {
		this.db = deps.db
		this.buildStartRequest = deps.buildStartRequest
		this.clientFactory = deps.clientFactory ?? ((server) => new AgentServerClient({ server }))
		this.seedInteractiveTurn = deps.seedInteractiveTurn
	}

	/**
	 * `DispatchFn` for the T12 session-dispatch queue. Picks a server, claims
	 * the session row's slot on it, dispatches over HTTPS, and rolls back the
	 * slot on failure.
	 */
	dispatch = async (sessionId: string, idempotencyKey: string): Promise<DispatchResult> => {
		const picked =
			(await this.getStickyAssignment(sessionId)) ?? (await this.pickLeastLoadedServer())
		if (!picked) {
			return { kind: 'no_capacity' }
		}

		const claimed = await this.claimSlot(sessionId, picked.server.id)
		if (!claimed) {
			// The session row is gone or already terminal — refuse the dispatch
			// permanently so the queue stops retrying.
			return {
				kind: 'permanent_failure',
				error: `Session ${sessionId} not in dispatchable state`,
			}
		}

		// Fetch the secret only after committing to this server so the full pool's
		// bearer tokens are never in memory at the same time.
		let secret: string | null
		try {
			secret = await this.fetchSecret(picked.server.id)
		} catch (err) {
			await this.releaseSlot(sessionId, picked.server.id)
			return {
				kind: 'transient_failure',
				error: `fetchSecret threw: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
		if (!secret) {
			await this.releaseSlot(sessionId, picked.server.id)
			return {
				kind: 'transient_failure',
				error: `agent-server ${picked.server.id} no longer in DB`,
			}
		}
		const serverRow: AgentServerRow = { ...picked.server, secret }

		let request: StartSessionRequest | null
		try {
			request = await this.buildStartRequest(sessionId)
		} catch (err) {
			await this.releaseSlot(sessionId, picked.server.id)
			// A workspace whose credentials are actually dead fails identically on
			// every server, every attempt. Retrying it five times with backoff only
			// delays the explanation the user needs — and the generic
			// "dispatch exhausted" message it eventually lands on actively points
			// away from the real cause. Fail once, with the reason attached.
			//
			// But only when the credential was shown to be dead. When we merely
			// could not reach Anthropic to check (our own 15s timeout, a 5xx from
			// the token endpoint), the retry is exactly what recovers it — and
			// hard-failing would tell the user to reconnect a subscription that
			// was never broken. Those stay transient.
			if (err instanceof LlmCredentialsUnavailableError && !err.transient) {
				return {
					kind: 'permanent_failure',
					error: err.detail,
					failureReason: err.toFailureReason(),
				}
			}
			return {
				kind: 'transient_failure',
				error: `buildStartRequest threw: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
		if (!request) {
			await this.releaseSlot(sessionId, picked.server.id)
			return {
				kind: 'permanent_failure',
				error: `Session ${sessionId} not dispatchable (gone or terminal)`,
			}
		}

		const client = this.clientFactory(serverRow)
		try {
			const response = await client.startSession(request)
			await this.markDispatched(sessionId, picked.server.id, response.sandboxName)
			if (this.seedInteractiveTurn) {
				try {
					await this.seedInteractiveTurn(sessionId)
				} catch (err) {
					// Don't fail the dispatch over this — the sandbox is already up and
					// the session is still usable via a later /input call, just without
					// its opening turn. Same rationale as launchContainer's local path.
					logger.error('Failed to seed initial interactive turn after remote dispatch', {
						sessionId,
						agentServerId: picked.server.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			logger.info('Session dispatched to agent-server', {
				sessionId,
				idempotencyKey,
				agentServerId: picked.server.id,
				agentServerUrl: picked.server.url,
				sandboxName: response.sandboxName,
				load: picked.active / picked.max,
			})
			return { kind: 'dispatched' }
		} catch (err) {
			await this.releaseSlot(sessionId, picked.server.id)
			if (err instanceof AgentServerAuthError) {
				logger.error('agent-server rejected bearer token — secret rotation race', {
					sessionId,
					agentServerId: picked.server.id,
					agentServerUrl: picked.server.url,
				})
				// 401 won't fix itself by retrying — needs an operator to rotate
				// the secret in the `agent_servers` row. Permanent failure stops
				// the queue from burning attempts on it.
				return {
					kind: 'permanent_failure',
					error: `agent-server ${picked.server.url} rejected bearer token`,
				}
			}
			const message = err instanceof Error ? err.message : String(err)
			logger.warn('agent-server dispatch transient failure', {
				sessionId,
				agentServerId: picked.server.id,
				agentServerUrl: picked.server.url,
				error: message,
			})
			return { kind: 'transient_failure', error: message }
		}
	}

	/**
	 * If `sessionId` is already pinned to a server from an earlier, interrupted
	 * dispatch attempt, returns that server so the retry stays sticky to it
	 * instead of `pickLeastLoadedServer()` choosing a different one (which
	 * `claimSlot` would then correctly refuse — see the class-level doc
	 * comment / MASKIN-DEV-6). Returns `null` when the session isn't pinned
	 * yet. If it's pinned to a server row that no longer exists (e.g.
	 * decommissioned mid-dispatch) or that has since transitioned away from
	 * `active` (e.g. an operator started draining/disabling it while the
	 * session was pinned), releases the stale pin and returns `null` so the
	 * caller falls through to a fresh `pickLeastLoadedServer()` pick — mirrors
	 * that method's own `status = 'active'` filter so a retry never lands on a
	 * server the operator has intentionally taken out of rotation.
	 */
	private async getStickyAssignment(sessionId: string): Promise<PickedServer | null> {
		const [session] = await this.db
			.select({ agentServerId: sessions.agentServerId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!session?.agentServerId) return null

		const serverId = session.agentServerId
		const [row] = await this.db
			.select({
				id: agentServers.id,
				url: agentServers.url,
				status: agentServers.status,
				max: agentServers.maxConcurrentSessions,
				active: sql<number>`COALESCE((
					SELECT COUNT(*)::int
					FROM sessions
					WHERE sessions.agent_server_id = agent_servers.id
					  AND sessions.status IN ('starting','running')
				), 0)`,
			})
			.from(agentServers)
			.where(eq(agentServers.id, serverId))
			.limit(1)

		if (!row || row.status !== 'active') {
			await this.releaseStickyPin(sessionId, serverId)
			return null
		}

		return {
			server: { id: row.id, url: row.url },
			active: Number(row.active) || 0,
			max: row.max,
		}
	}

	/**
	 * Releases a stale sticky pin found by `getStickyAssignment()`. Unlike the
	 * `releaseSlot()` calls in `dispatch()` (which run inside branches that
	 * already return a typed `DispatchResult` on failure), this one runs
	 * *before* `dispatch()` has committed to a server for this attempt — so a
	 * DB error here must not throw out of `getStickyAssignment()` and propagate
	 * as an unhandled rejection. On failure we log and still return, and the
	 * caller falls through to `pickLeastLoadedServer()` regardless; the stale
	 * pin is retried on the next dispatch attempt.
	 */
	private async releaseStickyPin(sessionId: string, serverId: string): Promise<void> {
		try {
			await this.releaseSlot(sessionId, serverId)
		} catch (err) {
			logger.warn('Failed to release stale sticky pin', {
				sessionId,
				agentServerId: serverId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	/**
	 * Returns the `active` agent-server with the lowest load (active sessions
	 * over its `max_concurrent_sessions`). Servers at or above capacity are
	 * excluded. Ties break by `id` for stability so a flapping seed order
	 * doesn't pingpong between equally-loaded hosts.
	 */
	async pickLeastLoadedServer(): Promise<PickedServer | null> {
		const rows = await this.db
			.select({
				id: agentServers.id,
				url: agentServers.url,
				max: agentServers.maxConcurrentSessions,
				active: sql<number>`COALESCE((
					SELECT COUNT(*)::int
					FROM sessions
					WHERE sessions.agent_server_id = agent_servers.id
					  AND sessions.status IN ('starting','running')
				), 0)`,
			})
			.from(agentServers)
			.where(eq(agentServers.status, 'active'))

		let best: PickedServer | null = null
		for (const row of rows) {
			const active = Number(row.active) || 0
			const max = row.max
			if (max <= 0 || active >= max) continue
			const load = active / max
			if (
				!best ||
				load < best.active / best.max ||
				(load === best.active / best.max && row.id < best.server.id)
			) {
				best = {
					server: { id: row.id, url: row.url },
					active,
					max,
				}
			}
		}
		return best
	}

	private async fetchSecret(serverId: string): Promise<string | null> {
		const [row] = await this.db
			.select({ secret: agentServers.secret })
			.from(agentServers)
			.where(eq(agentServers.id, serverId))
			.limit(1)
		return row?.secret ?? null
	}

	/**
	 * Claim the session's slot on `serverId` if it is still pending/queued/
	 * starting and not yet pinned to another server. Idempotent: re-claiming
	 * the same (session, server) returns the row again.
	 */
	private async claimSlot(sessionId: string, serverId: string): Promise<boolean> {
		const [row] = await this.db
			.update(sessions)
			.set({ agentServerId: serverId, updatedAt: new Date() })
			.where(
				and(
					eq(sessions.id, sessionId),
					inArray(sessions.status, ['pending', 'queued', 'starting']),
					sql`(${sessions.agentServerId} IS NULL OR ${sessions.agentServerId} = ${serverId})`,
				),
			)
			.returning({ id: sessions.id })
		return Boolean(row)
	}

	private async releaseSlot(sessionId: string, serverId: string): Promise<void> {
		await this.db
			.update(sessions)
			.set({ agentServerId: null, updatedAt: new Date() })
			.where(and(eq(sessions.id, sessionId), eq(sessions.agentServerId, serverId)))
	}

	private async markDispatched(
		sessionId: string,
		serverId: string,
		sandboxName: string,
	): Promise<void> {
		const [session] = await this.db
			.select({
				config: sessions.config,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		const config = (session?.config ?? {}) as Record<string, unknown>
		const timeoutSeconds = (config.timeout_seconds as number) ?? 7200
		const now = new Date()
		const [updated] = await this.db
			.update(sessions)
			.set({
				status: 'running',
				agentServerId: serverId,
				containerId: sandboxName,
				startedAt: now,
				timeoutAt: new Date(now.getTime() + timeoutSeconds * 1000),
				updatedAt: now,
			})
			.where(
				and(eq(sessions.id, sessionId), sql`${sessions.status} NOT IN ('completed', 'failed')`),
			)
			.returning({ id: sessions.id })

		// Same rationale as the local-container path in session-manager.ts —
		// without this, the frontend never learns the session left 'pending'
		// and live-activity surfaces (e.g. the chat typing indicator) never
		// refetch to pick it up.
		if (updated && session) {
			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_started',
				entityType: 'session',
				entityId: sessionId,
				data: {},
			})
		}
	}
}
