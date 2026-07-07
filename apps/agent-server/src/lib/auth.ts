import type { MiddlewareHandler } from 'hono'

export type BearerAuthDeps = {
	expectedSecret: string
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}

export function bearerAuth({ expectedSecret }: BearerAuthDeps): MiddlewareHandler {
	const expectedHeader = `Bearer ${expectedSecret}`
	return async (c, next) => {
		const header = c.req.header('authorization')
		if (!header || !timingSafeEqual(header, expectedHeader)) {
			return c.json({ error: 'unauthorized' }, 401)
		}
		await next()
		return
	}
}
