import { verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { loginSchema } from '@maskin/shared'
import { OpenAPIHono, createRoute, type z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST /login
const loginRoute = createRoute({
	method: 'post',
	path: '/login',
	tags: ['Auth'],
	summary: 'Login with email and password',
	request: {
		body: {
			content: {
				'application/json': {
					schema: loginSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Login successful',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid credentials',
		},
	},
})

app.openapi(loginRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const [actor] = await db.select().from(actors).where(eq(actors.email, body.email)).limit(1)

	if (!actor || !actor.passwordHash) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}

	const valid = await verifyPassword(body.password, actor.passwordHash)
	if (!valid) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}

	const { apiKey, passwordHash, ...actorWithoutSecrets } = actor
	return c.json(
		{
			...serialize(actorWithoutSecrets),
			api_key: actor.apiKey ?? '',
		} as z.infer<typeof actorWithKeySchema>,
		200,
	)
})

export default app
