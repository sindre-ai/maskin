import { randomBytes } from 'node:crypto'
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { hashPassword, verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import {
	changePasswordSchema,
	loginSchema,
	requestEmailChangeSchema,
	verifyEmailChangeSchema,
} from '@maskin/shared'
import { and, eq, gt } from 'drizzle-orm'
import { serializeActorWithKey } from '../lib/actor-response'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import { emitProfileFieldChanged } from '../lib/profile-telemetry'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function frontendBaseUrl(): string {
	return process.env.FRONTEND_URL?.replace(/\/$/, '') ?? 'http://localhost:5173'
}

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

	return c.json(serializeActorWithKey(actor, actor.apiKey ?? ''), 200)
})

// POST /password — change password
const changePasswordRoute = createRoute({
	method: 'post',
	path: '/password',
	tags: ['Auth'],
	summary: 'Change the authenticated user’s password',
	request: {
		body: {
			content: {
				'application/json': { schema: changePasswordSchema },
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Password updated and API key rotated',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Current password incorrect',
		},
	},
})

app.openapi(changePasswordRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	if (!actor || !actor.passwordHash) {
		return c.json(createApiError('UNAUTHORIZED', 'Cannot change password'), 401)
	}

	const valid = await verifyPassword(body.current_password, actor.passwordHash)
	if (!valid) {
		return c.json(createApiError('UNAUTHORIZED', 'Current password is incorrect'), 401)
	}

	const newHash = await hashPassword(body.new_password)
	// Rotate the API key so any leaked session credential is invalidated by the
	// same action that proves the user controls the account.
	const newApiKey = `ank_${randomBytes(24).toString('hex')}`

	const [updated] = await db
		.update(actors)
		.set({ passwordHash: newHash, apiKey: newApiKey, updatedAt: new Date() })
		.where(eq(actors.id, actorId))
		.returning()

	if (!updated) {
		return c.json(createApiError('UNAUTHORIZED', 'Cannot change password'), 401)
	}

	await emitProfileFieldChanged(db, actorId, 'password')

	return c.json(serializeActorWithKey(updated, newApiKey), 200)
})

// POST /email-change — request an email change
const requestEmailChangeRoute = createRoute({
	method: 'post',
	path: '/email-change',
	tags: ['Auth'],
	summary: 'Request an email change (sends verification link)',
	request: {
		body: {
			content: {
				'application/json': { schema: requestEmailChangeSchema },
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: actorWithKeySchema,
				},
			},
			description: 'Verification pending',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Current password incorrect',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Email already in use',
		},
	},
})

app.openapi(requestEmailChangeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	if (!actor || !actor.passwordHash) {
		return c.json(createApiError('UNAUTHORIZED', 'Cannot change email'), 401)
	}

	const valid = await verifyPassword(body.current_password, actor.passwordHash)
	if (!valid) {
		return c.json(createApiError('UNAUTHORIZED', 'Current password is incorrect'), 401)
	}

	// Block if another actor already uses this email. We check current and
	// pending values — a second user mid-flight to the same target would race
	// on verify, and the second one would get a confusing 500 from the unique
	// constraint when their verify lands.
	const [collision] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.email, body.new_email))
		.limit(1)
	if (collision && collision.id !== actorId) {
		return c.json(createApiError('CONFLICT', 'Email already in use'), 409)
	}

	const token = randomBytes(32).toString('hex')
	const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS)

	const [updated] = await db
		.update(actors)
		.set({
			pendingEmail: body.new_email,
			pendingEmailToken: token,
			pendingEmailExpiresAt: expiresAt,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, actorId))
		.returning()

	if (!updated) {
		return c.json(createApiError('UNAUTHORIZED', 'Cannot change email'), 401)
	}

	// Mailer is not wired (per T1 — see PR description). Log the verify URL to
	// stdout so dev can click through, and so the public launch checklist can
	// grep for `[email-change]` lines to confirm the integration path before
	// flipping a real sender on.
	const verifyUrl = `${frontendBaseUrl()}/verify-email?token=${token}`
	logger.info('[email-change] verification URL minted', {
		actorId,
		newEmail: body.new_email,
		verifyUrl,
		expiresAt: expiresAt.toISOString(),
	})

	return c.json(serializeActorWithKey(updated, actor.apiKey ?? ''), 200)
})

// POST /email-change/verify
const verifyEmailChangeRoute = createRoute({
	method: 'post',
	path: '/email-change/verify',
	tags: ['Auth'],
	summary: 'Verify a pending email change',
	request: {
		body: {
			content: { 'application/json': { schema: verifyEmailChangeSchema } },
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Email changed',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Token invalid or expired',
		},
	},
})

app.openapi(verifyEmailChangeRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const now = new Date()
	const [pending] = await db
		.select()
		.from(actors)
		.where(and(eq(actors.pendingEmailToken, body.token), gt(actors.pendingEmailExpiresAt, now)))
		.limit(1)

	if (!pending || !pending.pendingEmail) {
		return c.json(createApiError('BAD_REQUEST', 'Verification token is invalid or expired'), 400)
	}

	// Last-mile collision check — somebody else may have grabbed the address
	// between request and verify.
	const [collision] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.email, pending.pendingEmail))
		.limit(1)
	if (collision && collision.id !== pending.id) {
		// Clear the pending state so the user gets a clean retry path.
		await db
			.update(actors)
			.set({
				pendingEmail: null,
				pendingEmailToken: null,
				pendingEmailExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(eq(actors.id, pending.id))
		return c.json(createApiError('CONFLICT', 'Email already in use'), 400)
	}

	const [updated] = await db
		.update(actors)
		.set({
			email: pending.pendingEmail,
			pendingEmail: null,
			pendingEmailToken: null,
			pendingEmailExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, pending.id))
		.returning()

	if (!updated) {
		return c.json(createApiError('BAD_REQUEST', 'Verification token is invalid or expired'), 400)
	}

	await emitProfileFieldChanged(db, pending.id, 'email')

	return c.json(serializeActorWithKey(updated, updated.apiKey ?? ''), 200)
})

// POST /email-change/cancel
const cancelEmailChangeRoute = createRoute({
	method: 'post',
	path: '/email-change/cancel',
	tags: ['Auth'],
	summary: 'Cancel a pending email change',
	responses: {
		200: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Pending email change cleared',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(cancelEmailChangeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const [updated] = await db
		.update(actors)
		.set({
			pendingEmail: null,
			pendingEmailToken: null,
			pendingEmailExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, actorId))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serializeActorWithKey(updated, updated.apiKey ?? ''), 200)
})

export default app
