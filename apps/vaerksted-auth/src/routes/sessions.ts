import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { vaerkstedIdentity } from '../db/schema'
import { sessionMiddleware } from '../lib/session-middleware'
import { issueSessionToken } from '../lib/session-token'
import { SupabaseNotConfiguredError, requireSupabaseAdminClient } from '../lib/supabase'
import { InvalidSupabaseTokenError, verifySupabaseAccessToken } from '../lib/supabase-verify'
import type { AppEnv } from '../types'

// Same assumed Supabase Auth contract as POST /identities — see
// `lib/supabase-verify.ts`.
const sessionsBodySchema = z.object({
	supabase_access_token: z.string().min(1),
})

export const sessionsRoute = new Hono<AppEnv>()

// POST /sessions — existing identity login (design doc §6 step 2, and the
// Maskin-login-reuse path, §8). Unlike POST /identities, this does NOT
// create a new vaerksted_identity if none exists for the verified Supabase
// user — a login attempt for an identity that was never created via
// POST /identities is a 404, directing the caller back to /identities.
sessionsRoute.post('/sessions', async (c) => {
	const env = c.get('env')
	const db = c.get('db')

	let body: z.infer<typeof sessionsBodySchema>
	try {
		const parsed = sessionsBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400)
		}
		body = parsed.data
	} catch {
		return c.json({ error: 'invalid_json' }, 400)
	}

	let supabaseUser: Awaited<ReturnType<typeof verifySupabaseAccessToken>>
	try {
		const supabase = requireSupabaseAdminClient(env)
		supabaseUser = await verifySupabaseAccessToken(supabase, body.supabase_access_token)
	} catch (err) {
		if (err instanceof SupabaseNotConfiguredError) {
			return c.json({ error: 'server_misconfigured', message: err.message }, 503)
		}
		if (err instanceof InvalidSupabaseTokenError) {
			return c.json({ error: 'unauthorized', message: err.message }, 401)
		}
		throw err
	}

	if (!env.VAERKSTED_AUTH_SESSION_JWT_SECRET) {
		return c.json(
			{ error: 'server_misconfigured', message: 'VAERKSTED_AUTH_SESSION_JWT_SECRET not set' },
			503,
		)
	}

	const [identity] = await db
		.select()
		.from(vaerkstedIdentity)
		.where(eq(vaerkstedIdentity.supabaseUserId, supabaseUser.supabaseUserId))
		.limit(1)

	if (!identity) {
		return c.json(
			{ error: 'not_found', message: 'No vaerksted identity for this Supabase user yet' },
			404,
		)
	}

	const sessionToken = await issueSessionToken(identity.id, env.VAERKSTED_AUTH_SESSION_JWT_SECRET)

	return c.json({
		identity_id: identity.id,
		email: identity.email,
		session_token: sessionToken,
	})
})

// GET /sessions/me — session-authenticated, pure lookup, no side effects.
//
// Added for M5 (Maskin account linking): without this endpoint, a third
// party (Maskin) verifying a `session_token` would have no way to safely
// learn which vaerksted identity it belongs to. `POST /devices` is
// session-authenticated but performs a device-registration side effect —
// wrong tool for a caller that just wants to verify "who is this session."
// Without a dedicated verification endpoint, a client-supplied `identity_id`
// would have to be trusted directly, which lets any caller claim to be any
// identity. This route closes that gap: it verifies the session token via
// the same `sessionMiddleware()` every other session-authenticated route
// uses, and returns only `{identity_id, email}` — no mutation, no cert
// issuance.
sessionsRoute.get('/sessions/me', sessionMiddleware(), async (c) => {
	const db = c.get('db')
	const identityId = c.get('identityId')
	if (!identityId) {
		// Unreachable in practice — sessionMiddleware always sets identityId
		// before calling next() — but keeps this handler type-safe and fails
		// loudly instead of silently proceeding without an identity if that
		// invariant is ever broken by a future middleware change.
		return c.json({ error: 'unauthorized' }, 401)
	}

	const [identity] = await db
		.select()
		.from(vaerkstedIdentity)
		.where(eq(vaerkstedIdentity.id, identityId))
		.limit(1)

	if (!identity) {
		// The session token's identity no longer exists (shouldn't normally
		// happen — identities aren't deleted anywhere today — but fail closed
		// rather than returning a body with a null identity_id).
		return c.json({ error: 'not_found' }, 404)
	}

	return c.json({
		identity_id: identity.id,
		email: identity.email,
	})
})
