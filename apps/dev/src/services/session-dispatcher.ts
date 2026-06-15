import type { Database } from '@maskin/db'
import { agentServers, sessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
 */

export type StartSessionRequestBuilder = (sessionId: string) => Promise<StartSessionRequest | null>

export type AgentServerClientFactory = (server: AgentServerRow) => AgentServerClient

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
}

export interface PickedServer {
	server: AgentServerRow
	active: number
	max: number
}

export class SessionDispatcher {
	private readonly db: Database
	private readonly buildStartRequest: StartSessionRequestBuilder
	private readonly clientFactory: AgentServerClientFactory

	constructor(deps: SessionDispatcherDeps) {
		this.db = deps.db
		this.buildStartRequest = deps.buildStartRequest
		this.clientFactory = deps.clientFactory ?? ((server) => new AgentServerClient({ server }))
	}

	/**
	 * `DispatchFn` for the T12 session-dispatch queue. Picks a server, claims
	 * the session row's slot on it, dispatches over HTTPS, and rolls back the
	 * slot on failure.
	 */
	dispatch = async (sessionId: string, idempotencyKey: string): Promise<DispatchResult> => {
		const picked = await this.pickLeastLoadedServer()
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

		let request: StartSessionRequest | null
		try {
			request = await this.buildStartRequest(sessionId)
		} catch (err) {
			await this.releaseSlot(sessionId, picked.server.id)
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

		const client = this.clientFactory(picked.server)
		try {
			const response = await client.startSession(request)
			await this.markDispatched(sessionId, picked.server.id, response.sandboxName)
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
				secret: agentServers.secret,
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
					server: { id: row.id, url: row.url, secret: row.secret },
					active,
					max,
				}
			}
		}
		return best
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
		await this.db
			.update(sessions)
			.set({
				status: 'running',
				agentServerId: serverId,
				containerId: sandboxName,
				startedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(eq(sessions.id, sessionId), sql`${sessions.status} NOT IN ('completed', 'failed')`),
			)
	}
}
