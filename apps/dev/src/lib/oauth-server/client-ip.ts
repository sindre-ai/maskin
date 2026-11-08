import type { Context } from 'hono'
import { extractClientIp } from '../trusted-proxy'

/**
 * The caller's address for rate limiting. X-Forwarded-For is only believed when the socket
 * address belongs to a trusted proxy (extractClientIp), so a caller cannot pick its own bucket.
 * The Node server hands the socket over on c.env.incoming; the second read is the one the
 * other public routes use.
 */
export function requestClientIp(c: Context): string {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
	const socketIp =
		env?.incoming?.socket?.remoteAddress ??
		(c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	return extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
}
