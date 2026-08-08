import type { WSContext } from 'hono/ws'

// In-process registry of currently-connected GET /sync/ws sockets, keyed by
// identity_id (design doc §9: "fan out to online devices over a
// WebSocket"). A `Map<identityId, Set<WebSocket>>` is explicitly called out
// as sufficient for M4 — no cross-instance pub/sub yet, since Phase 1
// (design doc §10) is a single-instance deployment. Revisit if/when
// vaerksted-sync is ever horizontally scaled.
//
// Each entry also remembers the connection's deviceId so POST /sync/push can
// exclude "the sender" from fan-out — per the wire contract, "a device
// doesn't need its own push echoed back to it." Since push arrives over
// plain HTTP (not the WS connection itself), "the sender" is operationalized
// as "any currently-connected socket belonging to the pushing device",
// which is the only sender-identifying information available at push time.
type Connection = {
	ws: WSContext
	deviceId: string
}

const connectionsByIdentity = new Map<string, Set<Connection>>()

export function registerConnection(
	identityId: string,
	deviceId: string,
	ws: WSContext,
): Connection {
	const conn: Connection = { ws, deviceId }
	let set = connectionsByIdentity.get(identityId)
	if (!set) {
		set = new Set()
		connectionsByIdentity.set(identityId, set)
	}
	set.add(conn)
	return conn
}

export function unregisterConnection(identityId: string, conn: Connection): void {
	const set = connectionsByIdentity.get(identityId)
	if (!set) return
	set.delete(conn)
	if (set.size === 0) connectionsByIdentity.delete(identityId)
}

/**
 * Best-effort, fire-and-forget fan-out to every other currently-connected
 * socket belonging to `identityId`, excluding any connection whose deviceId
 * matches `excludeDeviceId` (the device that authored the push). A
 * disconnected device simply catches up later via GET /sync/pull?since= —
 * per design doc §9, undelivered-blob retention for offline devices is the
 * pull endpoint's job, not this function's.
 */
export function fanOut(identityId: string, excludeDeviceId: string, message: unknown): void {
	const set = connectionsByIdentity.get(identityId)
	if (!set) return
	const payload = JSON.stringify(message)
	for (const conn of set) {
		if (conn.deviceId === excludeDeviceId) continue
		try {
			conn.ws.send(payload)
		} catch (err) {
			// Best-effort: a send failure (e.g. socket mid-close) shouldn't fail
			// the push request that triggered it, and the device recovers via
			// GET /sync/pull?since= regardless.
			console.error('vaerksted-sync: WS fan-out send failed', err)
		}
	}
}

// Exposed for tests only — lets a test suite reset registry state between
// cases without restarting the process.
export function _resetConnectionsForTest(): void {
	connectionsByIdentity.clear()
}
