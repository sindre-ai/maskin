import type { Database } from '@maskin/db'
import { agentServers } from '@maskin/db/schema'
import { asc, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'

// One desktop VM per AGENT, hosted on an agent-server (see
// apps/agent-server/src/services/workspace-desktop.ts). A desktop is identified
// by (workspace, agent). There is no table recording which box hosts which
// desktop: every lookup asks the pool. That keeps this feature free of a schema
// change, at the cost of one cheap GET per server per lookup. Revisit with a
// pinning table if the pool grows past a handful of boxes, or if two concurrent
// first-time connects racing onto two different servers ever shows up in
// practice.
//
// This service does NOT decide who may reach which agent's desktop — see
// lib/desktop-access.ts, which every route and the stream relay call first.

export type DesktopServer = {
	id: string
	url: string
	secret: string
	status: 'active' | 'draining' | 'disabled'
}

export type LocatedDesktop = {
	server: DesktopServer
	// VNC password; handed to the browser with the ticket, never stored here.
	password: string
	// `suspended` when idle: the VM is asleep and the next use wakes it.
	status?: 'running' | 'suspended'
	// True only when this call provisioned a new desktop (vs. found one running).
	created?: boolean
}

export type AgentDesktopSummary = { agentId: string; status: 'running' | 'suspended' }

export interface WorkspaceDesktopServiceDeps {
	listServers: () => Promise<DesktopServer[]>
	fetchImpl?: typeof fetch
}

const LOOKUP_TIMEOUT_MS = 5_000
// First-time provisioning pulls an image and boots a microVM.
const ENSURE_TIMEOUT_MS = 200_000
// exec may run up to 120s in the VM; leave headroom for the extra hop.
const CONTROL_TIMEOUT_MS = 150_000
// Opening a tunnel starts two processes and waits for both to listen.
const PORTS_TIMEOUT_MS = 40_000

function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}${path}`
}

export class WorkspaceDesktopService {
	private readonly fetchImpl: typeof fetch

	constructor(private readonly deps: WorkspaceDesktopServiceDeps) {
		this.fetchImpl = deps.fetchImpl ?? fetch
	}

	private call(
		server: DesktopServer,
		method: 'GET' | 'PUT' | 'DELETE',
		workspaceId: string,
		agentId: string,
		timeoutMs: number,
	): Promise<Response> {
		return this.fetchImpl(joinUrl(server.url, `/desktops/${workspaceId}/${agentId}`), {
			method,
			headers: { Authorization: `Bearer ${server.secret}` },
			signal: AbortSignal.timeout(timeoutMs),
		})
	}

	/**
	 * Asks every active server whether it hosts this agent's desktop. A server
	 * that answers 404 is a definite "not here"; one that errors, times out or
	 * answers anything else has told us nothing, and `unknown` records that. Callers
	 * that would create or delete something must not treat unknown as absent.
	 */
	private async lookup(
		workspaceId: string,
		agentId: string,
	): Promise<{ found: LocatedDesktop | null; unknown: boolean }> {
		const servers = (await this.deps.listServers()).filter((s) => s.status !== 'disabled')
		const results = await Promise.all(
			servers.map(async (server): Promise<LocatedDesktop | 'absent' | 'unknown'> => {
				try {
					const res = await this.call(server, 'GET', workspaceId, agentId, LOOKUP_TIMEOUT_MS)
					if (res.status === 404) return 'absent'
					if (!res.ok) {
						logger.warn('desktop lookup got an error from agent-server', {
							serverId: server.id,
							status: res.status,
						})
						return 'unknown'
					}
					const body = (await res.json()) as { password?: unknown; status?: unknown }
					if (typeof body.password !== 'string') {
						logger.warn('desktop lookup answer had no password', { serverId: server.id })
						return 'unknown'
					}
					return {
						server,
						password: body.password,
						status: body.status === 'suspended' ? 'suspended' : 'running',
					}
				} catch (err) {
					logger.warn('desktop lookup failed on agent-server', {
						serverId: server.id,
						error: String(err),
					})
					return 'unknown'
				}
			}),
		)
		const found = results.find((r): r is LocatedDesktop => typeof r === 'object') ?? null
		return { found, unknown: !found && results.includes('unknown') }
	}

	/**
	 * Which server (if any) already hosts this agent's desktop. Read-only callers
	 * (the relay, port listing) get null for "not found or couldn't tell"; anything
	 * that provisions or removes goes through `lookup` and refuses to guess.
	 */
	async locate(workspaceId: string, agentId: string): Promise<LocatedDesktop | null> {
		return (await this.lookup(workspaceId, agentId)).found
	}

	/** Every agent in the workspace that has a computer, and whether it is asleep. */
	async list(workspaceId: string): Promise<AgentDesktopSummary[]> {
		const servers = (await this.deps.listServers()).filter((s) => s.status !== 'disabled')
		const perServer = await Promise.all(
			servers.map(async (server): Promise<AgentDesktopSummary[]> => {
				try {
					const res = await this.fetchImpl(joinUrl(server.url, `/desktops/${workspaceId}`), {
						headers: { Authorization: `Bearer ${server.secret}` },
						signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
					})
					if (!res.ok) return []
					const body = (await res.json()) as {
						desktops?: Array<{ agent_id?: unknown; status?: unknown }>
					}
					return (body.desktops ?? []).flatMap((d) =>
						typeof d.agent_id === 'string'
							? [
									{
										agentId: d.agent_id,
										status:
											d.status === 'suspended' ? ('suspended' as const) : ('running' as const),
									},
								]
							: [],
					)
				} catch (err) {
					logger.warn('desktop list failed on agent-server', {
						serverId: server.id,
						error: String(err),
					})
					return []
				}
			}),
		)
		return perServer.flat()
	}

	/**
	 * Existing desktop, or provision one on the first active server. A new one goes
	 * to `preferServerId` when that server is active: a computer can only tunnel
	 * into sandboxes on its own box, so it should start where the agent's session is.
	 */
	async ensure(
		workspaceId: string,
		agentId: string,
		opts: { preferServerId?: string } = {},
	): Promise<LocatedDesktop | null> {
		const { found: existing, unknown } = await this.lookup(workspaceId, agentId)
		// A server we couldn't reach may be the one hosting this agent's computer.
		// Provisioning elsewhere would give the agent a second, empty one and orphan
		// the first, so fail and let the caller retry.
		if (!existing && unknown) {
			throw new Error('could not tell whether this agent already has a computer')
		}
		// A suspended desktop is woken by PUT, which is idempotent and returns the
		// running desktop; a running one is returned as found.
		if (existing && existing.status !== 'suspended') return existing

		const target = existing?.server ?? (await this.pickNewServer(opts.preferServerId))
		if (!target) return null
		const res = await this.call(target, 'PUT', workspaceId, agentId, ENSURE_TIMEOUT_MS)
		if (!res.ok) {
			logger.error('agent-server failed to provision desktop', {
				serverId: target.id,
				status: res.status,
			})
			return null
		}
		const body = (await res.json()) as { password?: unknown }
		return typeof body.password === 'string'
			? {
					server: target,
					password: body.password,
					status: 'running',
					...(existing ? {} : { created: true }),
				}
			: null
	}

	private async pickNewServer(preferServerId?: string): Promise<DesktopServer | undefined> {
		const active = (await this.deps.listServers()).filter((s) => s.status === 'active')
		return active.find((s) => s.id === preferServerId) ?? active[0]
	}

	/**
	 * Dev servers an agent's computer can open: tunnels from the computer into a
	 * port in one of the agent's session sandboxes. Forwarded to the agent-server
	 * that hosts the computer, which picks the relay port from the computer's own
	 * block. Caller has already checked the session belongs to the agent.
	 */
	async ports(
		server: DesktopServer,
		workspaceId: string,
		agentId: string,
		action:
			| { type: 'expose'; sessionId: string; guestPort: number }
			| { type: 'list' }
			| { type: 'close'; relayPort: number },
	): Promise<{ status: number; body: unknown }> {
		const base = joinUrl(server.url, `/desktops/${workspaceId}/${agentId}/ports`)
		const headers: Record<string, string> = { Authorization: `Bearer ${server.secret}` }
		let res: Response
		if (action.type === 'expose') {
			res = await this.fetchImpl(base, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ session_id: action.sessionId, guest_port: action.guestPort }),
				signal: AbortSignal.timeout(PORTS_TIMEOUT_MS),
			})
		} else if (action.type === 'list') {
			res = await this.fetchImpl(base, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
		} else {
			res = await this.fetchImpl(`${base}/${action.relayPort}`, {
				method: 'DELETE',
				headers,
				signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			})
		}
		const parsed: unknown = await res.json().catch(() => ({ error: 'bad_gateway' }))
		return { status: res.status, body: parsed }
	}

	/**
	 * Agent control of an existing desktop: forwards `screenshot` / `input` /
	 * `exec` to the hosting agent-server, which relays it to the VM's desktopd.
	 * Provisions the desktop first, so an agent's first call just works.
	 * Returns null when no desktop could be found or started.
	 */
	async control(
		workspaceId: string,
		agentId: string,
		action: 'screenshot' | 'input' | 'exec',
		body: unknown,
		timeoutMs = CONTROL_TIMEOUT_MS,
	): Promise<{ status: number; body: unknown } | null> {
		const located = await this.ensure(workspaceId, agentId)
		if (!located) return null
		const res = await this.fetchImpl(
			joinUrl(located.server.url, `/desktops/${workspaceId}/${agentId}/${action}`),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${located.server.secret}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body ?? {}),
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		const parsed: unknown = await res.json().catch(() => ({ error: 'bad_gateway' }))
		return { status: res.status, body: parsed }
	}

	/** Removes the desktop wherever it lives. Returns whether one existed. */
	async remove(workspaceId: string, agentId: string): Promise<boolean> {
		const { found: located, unknown } = await this.lookup(workspaceId, agentId)
		if (!located) {
			// "Nothing to remove" only when every server said so.
			if (unknown) throw new Error('could not tell where this agent’s computer is')
			return false
		}
		const res = await this.call(located.server, 'DELETE', workspaceId, agentId, ENSURE_TIMEOUT_MS)
		return res.ok
	}
}

export function createWorkspaceDesktopService(db: Database): WorkspaceDesktopService {
	return new WorkspaceDesktopService({
		listServers: async () =>
			db
				.select({
					id: agentServers.id,
					url: agentServers.url,
					secret: agentServers.secret,
					status: agentServers.status,
				})
				.from(agentServers)
				.where(inArray(agentServers.status, ['active', 'draining']))
				.orderBy(asc(agentServers.createdAt)),
	})
}
