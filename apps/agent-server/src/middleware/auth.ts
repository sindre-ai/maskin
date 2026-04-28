import type { MiddlewareHandler } from 'hono'

export const authMiddleware: MiddlewareHandler = async (c, next) => {
	const expected = process.env.AGENT_SERVER_SECRET
	if (!expected) {
		return c.json({ error: 'Server misconfigured' }, 500)
	}
	const secret = c.req.header('X-Agent-Server-Secret')
	if (secret !== expected) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return next()
}
