import type { IncomingMessage } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { consumeDesktopTicket } from '../lib/desktop-ticket'
import { logger } from '../lib/logger'
import type { LocatedDesktop } from './workspace-desktop'

// Browser <-> apps/dev <-> agent-server <-> desktop VM. This is the first hop:
// it authenticates a WebSocket upgrade with a one-time ticket (see
// lib/desktop-ticket.ts), then splices the socket onto the agent-server's
// /desktops/:workspaceId/:agentId/stream route. Like the agent-server hop it works at
// the TCP level — it replays the handshake and pipes bytes, so no WebSocket
// library is involved and the framing is done by websockify in the VM.

export const DESKTOP_STREAM_PATH = '/api/desktop/stream'

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Never forwarded upstream: our own credential for the next hop replaces auth,
// and cookies belong to the browser's session with us, not the agent-server.
const DROPPED_HEADERS = new Set(['host', 'authorization', 'cookie'])

export interface DesktopRelayDeps {
	isMember: (actorId: string, workspaceId: string) => Promise<boolean>
	// May this actor reach THIS agent's desktop right now? (An agent: only its
	// own. A person: any agent in a workspace they belong to.)
	canAccess: (actorId: string, workspaceId: string, agentId: string) => Promise<boolean>
	locate: (workspaceId: string, agentId: string) => Promise<LocatedDesktop | null>
	// Injectable for tests; defaults to a plain/TLS TCP connection.
	openUpstream?: (url: URL) => Duplex
}

function defaultOpenUpstream(url: URL): Duplex {
	if (url.protocol === 'https:') {
		const port = url.port ? Number(url.port) : 443
		return tlsConnect({ host: url.hostname, port, servername: url.hostname })
	}
	return netConnect({ host: url.hostname, port: url.port ? Number(url.port) : 80 })
}

function reject(socket: Duplex, status: number, text: string): void {
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * True for a WebSocket upgrade aimed at the desktop stream. Synchronous on purpose: the
 * server has to decide WHICH upgrade handler gets a request before any of them runs,
 * because the voice WebSocket handler answers every upgrade it is shown (a path it does
 * not know gets a 401 and a closed socket), so the two must never both see one.
 */
export function isDesktopStreamRequest(req: Pick<IncomingMessage, 'url'>): boolean {
	return new URL(req.url ?? '', 'http://localhost').pathname === DESKTOP_STREAM_PATH
}

/** Returns true if the request was ours (handled or rejected). */
export async function handleDesktopStreamUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	deps: DesktopRelayDeps,
): Promise<boolean> {
	const url = new URL(req.url ?? '', 'http://localhost')
	if (url.pathname !== DESKTOP_STREAM_PATH) return false

	// Hold any bytes the client sends until the upstream is wired up.
	socket.pause()
	socket.on('error', () => socket.destroy())

	const ticket = url.searchParams.get('ticket')
	const claims = ticket ? consumeDesktopTicket(ticket) : null
	if (
		!claims ||
		!WORKSPACE_ID_RE.test(claims.workspaceId) ||
		!WORKSPACE_ID_RE.test(claims.agentId)
	) {
		reject(socket, 401, 'Unauthorized')
		return true
	}

	try {
		// Re-check at upgrade time, not just at ticket time: membership or
		// the agent's place in the workspace may have changed in the 30s between the two.
		if (
			!(await deps.isMember(claims.actorId, claims.workspaceId)) ||
			!(await deps.canAccess(claims.actorId, claims.workspaceId, claims.agentId))
		) {
			reject(socket, 403, 'Forbidden')
			return true
		}
		const located = await deps.locate(claims.workspaceId, claims.agentId)
		if (!located) {
			reject(socket, 404, 'Not Found')
			return true
		}

		const target = new URL(located.server.url)
		const upstream = (deps.openUpstream ?? defaultOpenUpstream)(target)
		const teardown = (): void => {
			socket.destroy()
			upstream.destroy()
		}
		upstream.on('error', (err) => {
			logger.warn('desktop stream upstream error', {
				workspaceId: claims.workspaceId,
				error: String(err),
			})
			teardown()
		})
		socket.on('close', teardown)
		upstream.on('close', teardown)

		// 'secureConnect' for TLS, 'connect' for plain TCP — whichever the
		// upstream emits first once it is writable.
		let started = false
		const start = (): void => {
			if (started) return
			started = true
			const lines = [
				`GET /desktops/${claims.workspaceId}/${claims.agentId}/stream HTTP/1.1`,
				`Host: ${target.host}`,
				`Authorization: Bearer ${located.server.secret}`,
			]
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const key = req.rawHeaders[i] as string
				if (DROPPED_HEADERS.has(key.toLowerCase())) continue
				lines.push(`${key}: ${req.rawHeaders[i + 1]}`)
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
			if (head.length > 0) upstream.write(head)
			socket.pipe(upstream)
			upstream.pipe(socket)
			socket.resume()
		}
		upstream.once('connect', start)
		upstream.once('secureConnect', start)
		// Test doubles and already-connected sockets expose no connect event.
		if ((upstream as { connecting?: boolean }).connecting === false) start()
		return true
	} catch (err) {
		logger.error('desktop stream upgrade failed', { error: String(err) })
		reject(socket, 502, 'Bad Gateway')
		return true
	}
}
