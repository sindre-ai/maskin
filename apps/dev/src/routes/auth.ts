import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { loginSchema, resolveWebAppBaseUrl } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { sendPasswordResetEmail } from '../lib/email-triggers'
import { createApiError, validationFailureHook } from '../lib/errors'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'

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

	const { apiKey, passwordHash, systemPrompt, llmProvider, llmConfig, ...actorWithoutSecrets } =
		actor
	return c.json(
		{
			...serialize(actorWithoutSecrets),
			system_prompt: systemPrompt,
			llm_provider: llmProvider,
			llm_config: llmConfig,
			api_key: actor.apiKey ?? '',
		} as z.infer<typeof actorWithKeySchema>,
		200,
	)
})

// POST /request-password-reset — unauthenticated. Always returns 200 with
// { ok: true } so callers cannot enumerate registered emails from the response
// shape or timing tier. When a matching human account exists, the trigger
// fires the PasswordReset email fire-and-forget; otherwise it's a no-op.
const requestPasswordResetSchema = z.object({
	email: z.string().email(),
})

const requestPasswordResetRoute = createRoute({
	method: 'post',
	path: '/request-password-reset',
	tags: ['Auth'],
	summary: 'Request a password-reset email',
	description:
		'Always responds 200 to prevent user enumeration. When the email matches a human account with a password, a reset email is dispatched fire-and-forget.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: requestPasswordResetSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
			description: 'Reset email dispatched if the account exists',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(requestPasswordResetRoute, async (c) => {
	const db = c.get('db')
	const { email } = c.req.valid('json')

	void sendPasswordResetEmail({
		db,
		email,
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
	})

	return c.json({ ok: true as const }, 200)
})

export default app
