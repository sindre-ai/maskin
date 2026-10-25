import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, deviceAuthCodes } from '@maskin/db/schema'
import {
	DEVICE_AUTH_EXPIRES_IN_SECONDS,
	DEVICE_AUTH_POLL_INTERVAL_SECONDS,
	deviceAuthCodeBodySchema,
	deviceAuthPreviewResponseSchema,
	deviceAuthStartResponseSchema,
	deviceAuthStartSchema,
	deviceAuthTokenSchema,
	formatUserCode,
	normalizeUserCode,
} from '@maskin/shared'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { generateDeviceCode, generateUserCode, hashCode } from '../lib/device-auth-codes'
import { createApiError, validationFailureHook } from '../lib/errors'
import { frontendBaseUrl } from '../lib/file-urls'
import { createWindowLimiter } from '../lib/fixed-window-limiter'
import { logger } from '../lib/logger'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { extractClientIp } from '../lib/trusted-proxy'

// Device sign-in (RFC 8628): a TV with no keyboard shows a short code, a signed-in person approves
// it at /tv on a phone or laptop, and the TV, polling, is handed the same session
// `POST /api/auth/login` would return.
//
//   POST /start    public   the TV asks for a code pair
//   POST /token    public   the TV polls; once approved, receives the actor + key exactly once
//   GET  /preview  auth     the approval page shows which device is asking
//   POST /approve  auth     a signed-in HUMAN approves the code they typed
//   POST /deny     auth     ...or refuses it
//
// The user code is short on purpose, so guessing is bounded three ways: it is useless without a
// signed-in human to approve it, it lives ten minutes, and every endpoint is rate limited.

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const startLimiter = createWindowLimiter({ limit: 10, windowMs: 60_000 })
const tokenLimiter = createWindowLimiter({ limit: 60, windowMs: 60_000 })
const approverLimiter = createWindowLimiter({ limit: 20, windowMs: 60_000 })

/** Exposed so integration tests do not poison each other through shared limiter state. */
export function resetDeviceAuthLimitersForTests() {
	startLimiter.reset()
	tokenLimiter.reset()
	approverLimiter.reset()
}

/** Rows this old can never be used again; swept opportunistically when a new code is minted. */
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000

function callerIp(c: { req: { raw: Request; header(name: string): string | undefined } }): string {
	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	return extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
}

function rateLimited(c: { header(n: string, v: string): void }, retryAfterMs: number) {
	c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
	return createApiError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.')
}

// MARK: start

const startRoute = createRoute({
	method: 'post',
	path: '/start',
	tags: ['Auth'],
	summary: 'Begin a device sign-in',
	description:
		'Public. A device without a keyboard asks for a code pair. Show `user_code` to the person and poll `/token` with `device_code` every `interval` seconds.',
	request: {
		body: { content: { 'application/json': { schema: deviceAuthStartSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: deviceAuthStartResponseSchema } },
			description: 'Code pair created',
		},
		429: { content: { 'application/json': { schema: errorSchema } }, description: 'Rate limited' },
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Could not mint a code',
		},
	},
})

app.openapi(startRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const limit = startLimiter.hit(callerIp(c))
	if (!limit.allowed) return c.json(rateLimited(c, limit.retryAfterMs), 429)

	const deviceCode = generateDeviceCode()
	const expiresAt = new Date(Date.now() + DEVICE_AUTH_EXPIRES_IN_SECONDS * 1000)

	// A user-code collision (1 in ~3e11 against a handful of live rows) is retried, never reported.
	let userCode = ''
	for (let attempt = 0; attempt < 5; attempt++) {
		userCode = generateUserCode()
		const inserted = await db
			.insert(deviceAuthCodes)
			.values({
				deviceCodeHash: hashCode(deviceCode),
				userCodeHash: hashCode(userCode),
				clientSource: body.client,
				deviceName: body.device_name ?? null,
				expiresAt,
			})
			.onConflictDoNothing({ target: deviceAuthCodes.userCodeHash })
			.returning({ id: deviceAuthCodes.id })
		if (inserted.length > 0) break
		userCode = ''
	}
	if (!userCode) {
		return c.json(createApiError('INTERNAL_ERROR', 'Could not create a sign-in code'), 500)
	}

	// Housekeeping, not correctness: failing to sweep must never fail a sign-in.
	db.delete(deviceAuthCodes)
		.where(lt(deviceAuthCodes.expiresAt, new Date(Date.now() - SWEEP_AFTER_MS)))
		.catch((err) => logger.warn('device-auth: sweep failed', { error: String(err) }))

	const verificationUri = `${frontendBaseUrl()}/tv`
	return c.json(
		{
			device_code: deviceCode,
			user_code: formatUserCode(userCode),
			verification_uri: verificationUri,
			verification_uri_complete: `${verificationUri}?code=${formatUserCode(userCode)}`,
			expires_in: DEVICE_AUTH_EXPIRES_IN_SECONDS,
			interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
		},
		201,
	)
})

// MARK: token

const tokenResponseSchema = z.object({
	status: z.enum(['pending', 'approved', 'denied', 'expired']),
	/** Seconds between polls, while pending. */
	interval: z.number().int().positive().optional(),
	/** The signed-in actor with the key, exactly as `POST /api/auth/login` returns it. Present once,
	 * on the single response that carries `status: approved`. */
	actor: actorWithKeySchema.optional(),
})

const tokenRoute = createRoute({
	method: 'post',
	path: '/token',
	tags: ['Auth'],
	summary: 'Poll a device sign-in',
	description:
		'Public. Poll with the `device_code` from `/start`. `pending`: keep polling. `approved`: the response carries the actor and API key, once; the code is then spent. `denied` and `expired`: show a new code.',
	request: {
		body: { content: { 'application/json': { schema: deviceAuthTokenSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: tokenResponseSchema } },
			description: 'Current state of the sign-in',
		},
		429: { content: { 'application/json': { schema: errorSchema } }, description: 'Rate limited' },
	},
})

app.openapi(tokenRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const limit = tokenLimiter.hit(callerIp(c))
	if (!limit.allowed) return c.json(rateLimited(c, limit.retryAfterMs), 429)

	const hash = hashCode(body.device_code)
	const [row] = await db
		.select()
		.from(deviceAuthCodes)
		.where(eq(deviceAuthCodes.deviceCodeHash, hash))
		.limit(1)

	// An unknown code and a spent or lapsed one answer the same, so the response never confirms
	// that a guessed code once existed.
	if (!row || row.status === 'consumed' || row.expiresAt.getTime() <= Date.now()) {
		return c.json({ status: 'expired' as const }, 200)
	}
	if (row.status === 'denied') return c.json({ status: 'denied' as const }, 200)
	if (row.status === 'pending' || !row.actorId) {
		return c.json({ status: 'pending' as const, interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS }, 200)
	}

	// Approved: spend the code. The UPDATE is the single-use gate, so two polls racing for it cannot
	// both receive the session.
	const [spent] = await db
		.update(deviceAuthCodes)
		.set({ status: 'consumed', consumedAt: new Date() })
		.where(and(eq(deviceAuthCodes.id, row.id), eq(deviceAuthCodes.status, 'approved')))
		.returning({ actorId: deviceAuthCodes.actorId })
	if (!spent?.actorId) return c.json({ status: 'expired' as const }, 200)

	const [actor] = await db.select().from(actors).where(eq(actors.id, spent.actorId)).limit(1)
	if (!actor) return c.json({ status: 'expired' as const }, 200)

	logger.info('device-auth: session issued', { actorId: actor.id, client: row.clientSource })
	const { apiKey, passwordHash, systemPrompt, llmProvider, llmConfig, ...actorWithoutSecrets } =
		actor
	return c.json(
		{
			status: 'approved' as const,
			actor: {
				...serialize(actorWithoutSecrets),
				system_prompt: systemPrompt,
				llm_provider: llmProvider,
				llm_config: llmConfig,
				api_key: apiKey ?? '',
			} as z.infer<typeof actorWithKeySchema>,
		},
		200,
	)
})

// MARK: approve side (signed-in humans)

/** Approving a sign-in hands out a session, so only a person may do it: an agent's key must not be
 * able to mint sessions for other devices. */
function requireHuman(c: { get(key: 'actorType'): string }) {
	return c.get('actorType') === 'human'
}

const previewRoute = createRoute({
	method: 'get',
	path: '/preview',
	tags: ['Auth'],
	summary: 'Which device is asking, for a code',
	request: { query: z.object({ user_code: z.string().min(1).max(32) }) },
	responses: {
		200: {
			content: { 'application/json': { schema: deviceAuthPreviewResponseSchema } },
			description: 'The pending sign-in this code belongs to',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'No such code' },
		429: { content: { 'application/json': { schema: errorSchema } }, description: 'Rate limited' },
	},
})

app.openapi(previewRoute, async (c) => {
	const db = c.get('db')
	if (!requireHuman(c)) return c.json(createApiError('FORBIDDEN', 'Only a person can approve'), 403)
	const limit = approverLimiter.hit(c.get('actorId'))
	if (!limit.allowed) return c.json(rateLimited(c, limit.retryAfterMs), 429)

	const code = normalizeUserCode(c.req.valid('query').user_code)
	const [row] = code
		? await db
				.select()
				.from(deviceAuthCodes)
				.where(
					and(
						eq(deviceAuthCodes.userCodeHash, hashCode(code)),
						eq(deviceAuthCodes.status, 'pending'),
						gt(deviceAuthCodes.expiresAt, sql`now()`),
					),
				)
				.limit(1)
		: []
	if (!row) return c.json(createApiError('NOT_FOUND', 'That code is not valid or has expired'), 404)

	return c.json(
		{
			client: row.clientSource as z.infer<typeof deviceAuthPreviewResponseSchema>['client'],
			device_name: row.deviceName,
			created_at: row.createdAt.toISOString(),
		},
		200,
	)
})

const decisionResponses = {
	200: {
		content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
		description: 'Recorded',
	},
	403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
	404: { content: { 'application/json': { schema: errorSchema } }, description: 'No such code' },
	429: { content: { 'application/json': { schema: errorSchema } }, description: 'Rate limited' },
} as const

async function decide(
	db: Database,
	userCodeRaw: string,
	actorId: string,
	next: 'approved' | 'denied',
): Promise<boolean> {
	const code = normalizeUserCode(userCodeRaw)
	if (!code) return false
	// One conditional UPDATE: only a live, still-pending code can be decided, and only once.
	const updated = await db
		.update(deviceAuthCodes)
		.set({
			status: next,
			actorId: next === 'approved' ? actorId : null,
			approvedAt: next === 'approved' ? new Date() : null,
		})
		.where(
			and(
				eq(deviceAuthCodes.userCodeHash, hashCode(code)),
				eq(deviceAuthCodes.status, 'pending'),
				gt(deviceAuthCodes.expiresAt, sql`now()`),
			),
		)
		.returning({ id: deviceAuthCodes.id, clientSource: deviceAuthCodes.clientSource })
	if (updated.length === 0) return false
	logger.info(`device-auth: ${next}`, { actorId, client: updated[0]?.clientSource })
	return true
}

const approveRoute = createRoute({
	method: 'post',
	path: '/approve',
	tags: ['Auth'],
	summary: 'Approve a device sign-in',
	request: {
		body: { content: { 'application/json': { schema: deviceAuthCodeBodySchema } } },
	},
	responses: decisionResponses,
})

app.openapi(approveRoute, async (c) => {
	if (!requireHuman(c)) return c.json(createApiError('FORBIDDEN', 'Only a person can approve'), 403)
	const limit = approverLimiter.hit(c.get('actorId'))
	if (!limit.allowed) return c.json(rateLimited(c, limit.retryAfterMs), 429)
	const ok = await decide(c.get('db'), c.req.valid('json').user_code, c.get('actorId'), 'approved')
	if (!ok) return c.json(createApiError('NOT_FOUND', 'That code is not valid or has expired'), 404)
	return c.json({ ok: true as const }, 200)
})

const denyRoute = createRoute({
	method: 'post',
	path: '/deny',
	tags: ['Auth'],
	summary: 'Refuse a device sign-in',
	request: {
		body: { content: { 'application/json': { schema: deviceAuthCodeBodySchema } } },
	},
	responses: decisionResponses,
})

app.openapi(denyRoute, async (c) => {
	if (!requireHuman(c)) return c.json(createApiError('FORBIDDEN', 'Only a person can refuse'), 403)
	const limit = approverLimiter.hit(c.get('actorId'))
	if (!limit.allowed) return c.json(rateLimited(c, limit.retryAfterMs), 429)
	const ok = await decide(c.get('db'), c.req.valid('json').user_code, c.get('actorId'), 'denied')
	if (!ok) return c.json(createApiError('NOT_FOUND', 'That code is not valid or has expired'), 404)
	return c.json({ ok: true as const }, 200)
})

export default app
