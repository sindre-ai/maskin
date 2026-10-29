import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { issueLoginKey, verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { loginSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { toActorWithKeyResponse } from '../lib/actor-response'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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

	// Stored keys are hashed, so a login mints a new key instead of reading one back. The phone app
	// names itself in X-Client-Source and gets its own kind, which keeps web logins from ever
	// revoking it through the per-kind cap. The header only picks a bucket; it grants nothing.
	const fromIos = c.req.header(CLIENT_SOURCE_HEADER)?.trim().toLowerCase() === 'ios'
	const key = await issueLoginKey(db, actor.id, fromIos ? 'login_ios' : 'login')

	return c.json(toActorWithKeyResponse(actor, key), 200)
})

export default app
