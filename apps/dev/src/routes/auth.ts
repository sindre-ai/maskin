import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { hashPassword, issueLoginKey, revokeActorKeys, verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { sendPasswordResetEmail } from '@maskin/email'
import { forgotPasswordSchema, loginSchema, resetPasswordSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { toActorWithKeyResponse } from '../lib/actor-response'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { createWindowLimiter } from '../lib/fixed-window-limiter'
import { logger } from '../lib/logger'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import {
	consumePasswordResetToken,
	createPasswordResetToken,
	resolvePasswordResetUrl,
} from '../lib/password-reset'
import { extractClientIp } from '../lib/trusted-proxy'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

// Brakes on the two signed-out reset routes. Per IP on both; per email on the request route so
// one inbox cannot be flooded. Past the per-email limit the answer stays the neutral 200 (a 429
// there would show the address has an account).
const forgotIpLimiter = createWindowLimiter({ limit: 10, windowMs: 15 * 60 * 1000 })
const forgotEmailLimiter = createWindowLimiter({ limit: 3, windowMs: 60 * 60 * 1000 })
const resetIpLimiter = createWindowLimiter({ limit: 10, windowMs: 15 * 60 * 1000 })

/** Test-only. */
export function _resetPasswordResetLimiters(): void {
	forgotIpLimiter.reset()
	forgotEmailLimiter.reset()
	resetIpLimiter.reset()
}

const okSchema = z.object({ ok: z.literal(true) })

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

// POST /forgot-password
const forgotPasswordRoute = createRoute({
	method: 'post',
	path: '/forgot-password',
	tags: ['Auth'],
	summary: 'Email a password reset link',
	description:
		'Always answers the same 200, whether or not the email has an account with a password.',
	request: {
		body: { content: { 'application/json': { schema: forgotPasswordSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: okSchema } },
			description: 'If the email has an account, a link was sent',
		},
		429: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Too many requests from this IP',
		},
	},
})

app.openapi(forgotPasswordRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	const ip = extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
	if (!forgotIpLimiter.hit(ip).allowed) {
		return c.json(createApiError('RATE_LIMITED', 'Too many requests, try again later'), 429)
	}
	const withinEmailLimit = forgotEmailLimiter.hit(body.email.trim().toLowerCase()).allowed

	const [actor] = await db.select().from(actors).where(eq(actors.email, body.email)).limit(1)

	if (withinEmailLimit && actor?.passwordHash) {
		const to = body.email
		const actorId = actor.id
		// Not awaited: the token write and the send would make an existing account answer slower
		// than an unknown one. Failures are logged without the address or the token.
		void (async () => {
			const token = await createPasswordResetToken(db, actorId)
			const resetUrl = resolvePasswordResetUrl(token)
			if (!resetUrl) {
				logger.error('Password reset not sent: APP_URL is unset while RESEND_API_KEY is set')
				return
			}
			await sendPasswordResetEmail({ to, resetUrl })
		})().catch((err) => {
			logger.error('Password reset email failed', {
				error: err instanceof Error ? err.name : 'unknown',
			})
		})
	}

	return c.json({ ok: true as const }, 200)
})

// POST /reset-password
const resetPasswordRoute = createRoute({
	method: 'post',
	path: '/reset-password',
	tags: ['Auth'],
	summary: 'Set a new password with a reset link token',
	request: {
		body: { content: { 'application/json': { schema: resetPasswordSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: okSchema } },
			description: 'Password changed; existing sign-ins ended',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The link is invalid, used or expired',
		},
		429: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Too many attempts from this IP',
		},
	},
})

app.openapi(resetPasswordRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	const ip = extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
	if (!resetIpLimiter.hit(ip).allowed) {
		return c.json(createApiError('RATE_LIMITED', 'Too many attempts, try again later'), 429)
	}

	const passwordHash = await hashPassword(body.password)
	const actorId = await db.transaction(async (tx) => {
		const id = await consumePasswordResetToken(tx, body.token)
		if (!id) return null
		await tx.update(actors).set({ passwordHash }).where(eq(actors.id, id))
		// Same kinds a key rotation ends (routes/actors.ts): web and iOS logins and the primary
		// key. Personal keys and agent session keys are left alone.
		await revokeActorKeys(tx, id, ['primary', 'login', 'login_ios'])
		return id
	})
	if (!actorId) {
		return c.json(createApiError('BAD_REQUEST', 'This reset link is invalid or has expired'), 400)
	}

	return c.json({ ok: true as const }, 200)
})

export default app
