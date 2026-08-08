import { Hono } from 'hono'
import type { UpgradeWebSocket } from 'hono/ws'
import { deviceCertMiddleware } from '../lib/device-cert-middleware'
import { registerConnection, unregisterConnection } from '../lib/ws-registry'
import type { AppEnv } from '../types'

// GET /sync/ws — WebSocket upgrade, device-cert authenticated.
//
// AUTH-BEFORE-UPGRADE: `deviceCertMiddleware()` runs as an ordinary Hono
// middleware directly in front of `upgradeWebSocket(...)`, exactly like any
// other protected route (`app.get(path, deviceCertMiddleware(), handler)`).
// This works because `@hono/node-ws`'s `injectWebSocket(server)` handles the
// raw Node `http.Server` "upgrade" event by re-dispatching the request
// through the *entire* Hono app via `app.request(url, { headers }, env)`
// (confirmed by reading `@hono/node-ws@1.3.1`'s actual `dist/index.js`
// rather than assuming its shape) — so the full middleware chain, including
// this one, runs before the upgrade handshake completes. If
// `deviceCertMiddleware()` returns a 401 without calling `next()`, the
// `upgradeWebSocket` handler inside it never runs, no WS "connection" event
// is ever emitted for that request, and `@hono/node-ws` closes the raw
// socket with the 401 response instead of completing the handshake. This is
// the "verify the headers before completing the upgrade" path the task
// spec asked for — not the onOpen-based fallback (which was the documented
// acceptable alternative if the API made this awkward; it didn't).
export function createWsRoute(upgradeWebSocket: UpgradeWebSocket): Hono<AppEnv> {
	const route = new Hono<AppEnv>()

	route.get(
		'/sync/ws',
		deviceCertMiddleware(),
		upgradeWebSocket((c) => {
			const identityId = c.get('identityId') as string
			const deviceId = c.get('deviceId') as string
			let conn: ReturnType<typeof registerConnection> | undefined

			return {
				onOpen(_evt, ws) {
					// Register keyed by identity_id (design doc §9: "fan out to
					// online devices"), remembering deviceId so push's fan-out can
					// exclude the pushing device's own socket(s).
					conn = registerConnection(identityId, deviceId, ws)
				},
				onMessage() {
					// This channel is server -> client push-only for M4. Inbound
					// client messages (e.g. a client-side keepalive ping) are
					// accepted without erroring the connection, but otherwise
					// intentionally ignored — there is no client -> server WS
					// protocol defined by the design doc.
				},
				onClose() {
					if (conn) unregisterConnection(identityId, conn)
				},
				onError(evt) {
					console.error('vaerksted-sync: WS error', evt)
					if (conn) unregisterConnection(identityId, conn)
				},
			}
		}),
	)

	return route
}
