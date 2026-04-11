import type { MiddlewareHandler } from 'hono'

export const authMiddleware: MiddlewareHandler = async (c, next) => {
	const secret = c.req.header('X-Agent-Server-Secret')
	if (secret !== process.env.AGENT_SERVER_SECRET) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	await next()
}
