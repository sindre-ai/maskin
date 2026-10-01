import type { Database } from '@maskin/db'
import { agentServers } from '@maskin/db/schema'
import { asc, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'

// One desktop VM per workspace, hosted on an agent-server (see
// apps/agent-server/src/services/workspace-desktop.ts). There is no table
// recording which box hosts which workspace: every lookup asks the pool. That
// keeps this feature free of a schema change, at the cost of one cheap GET per
// server per lookup. Revisit with a pinning table if the pool grows past a
// handful of boxes, or if two concurrent first-time connects racing onto two
// different servers ever shows up in practice.

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
	// True only when this call provisioned a new desktop (vs. found one running).
	created?: boolean
}

export interface WorkspaceDesktopServiceDeps {
	listServers: () => Promise<DesktopServer[]>
	fetchImpl?: typeof fetch
}

const LOOKUP_TIMEOUT_MS = 5_000
// First-time provisioning pulls an image and boots a microVM.
const ENSURE_TIMEOUT_MS = 200_000

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
		timeoutMs: number,
	): Promise<Response> {
		return this.fetchImpl(joinUrl(server.url, `/desktops/${workspaceId}`), {
			method,
			headers: { Authorization: `Bearer ${server.secret}` },
			signal: AbortSignal.timeout(timeoutMs),
		})
	}

	/** Which server (if any) already hosts this workspace's desktop. */
	async locate(workspaceId: string): Promise<LocatedDesktop | null> {
		const servers = (await this.deps.listServers()).filter((s) => s.status !== 'disabled')
		const results = await Promise.all(
			servers.map(async (server): Promise<LocatedDesktop | null> => {
				try {
					const res = await this.call(server, 'GET', workspaceId, LOOKUP_TIMEOUT_MS)
					if (!res.ok) return null
					const body = (await res.json()) as { password?: unknown }
					return typeof body.password === 'string' ? { server, password: body.password } : null
				} catch (err) {
					logger.warn('desktop lookup failed on agent-server', {
						serverId: server.id,
						error: String(err),
					})
					return null
				}
			}),
		)
		return results.find((r): r is LocatedDesktop => r !== null) ?? null
	}

	/** Existing desktop, or provision one on the first active server. */
	async ensure(workspaceId: string): Promise<LocatedDesktop | null> {
		const existing = await this.locate(workspaceId)
		if (existing) return existing

		const target = (await this.deps.listServers()).find((s) => s.status === 'active')
		if (!target) return null
		const res = await this.call(target, 'PUT', workspaceId, ENSURE_TIMEOUT_MS)
		if (!res.ok) {
			logger.error('agent-server failed to provision desktop', {
				serverId: target.id,
				status: res.status,
			})
			return null
		}
		const body = (await res.json()) as { password?: unknown }
		return typeof body.password === 'string'
			? { server: target, password: body.password, created: true }
			: null
	}

	/** Removes the desktop wherever it lives. Returns whether one existed. */
	async remove(workspaceId: string): Promise<boolean> {
		const located = await this.locate(workspaceId)
		if (!located) return false
		const res = await this.call(located.server, 'DELETE', workspaceId, ENSURE_TIMEOUT_MS)
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
