import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { vaerkstedIdentity } from '../db/schema'
import { issueSessionToken } from '../lib/session-token'
import { SupabaseNotConfiguredError, requireSupabaseAdminClient } from '../lib/supabase'
import { InvalidSupabaseTokenError, verifySupabaseAccessToken } from '../lib/supabase-verify'
import type { AppEnv } from '../types'

// See `lib/supabase-verify.ts` for the full documented assumption about what
// payload the client hands back from Supabase Auth's client-side flow.
const identitiesBodySchema = z.object({
	supabase_access_token: z.string().min(1),
})

export const identitiesRoute = new Hono<AppEnv>()

// POST /identities — new identity via Supabase Auth (magic link / Google /
// Microsoft OAuth per design doc §6a's priority order). Design doc §6 step
// 2: "New identity: POST /identities via whichever credential method the
// user picks." Upserts vaerksted_identity keyed by supabase_user_id so a
// retried/duplicate call is idempotent rather than erroring — the "new"-ness
// is about the identity record potentially not existing yet, not a strict
// create-or-409 semantic (a second call for the same Supabase user should
// behave like POST /sessions, not fail).
identitiesRoute.post('/identities', async (c) => {
	const env = c.get('env')
	const db = c.get('db')

	let body: z.infer<typeof identitiesBodySchema>
	try {
		const parsed = identitiesBodySchema.safeParse(await c.req.json())
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

	const [existing] = await db
		.select()
		.from(vaerkstedIdentity)
		.where(eq(vaerkstedIdentity.supabaseUserId, supabaseUser.supabaseUserId))
		.limit(1)

	const identity =
		existing ??
		(
			await db
				.insert(vaerkstedIdentity)
				.values({
					supabaseUserId: supabaseUser.supabaseUserId,
					email: supabaseUser.email,
				})
				.returning()
		)[0]

	if (!identity) {
		return c.json({ error: 'internal_error', message: 'Failed to create identity' }, 500)
	}

	const sessionToken = await issueSessionToken(identity.id, env.VAERKSTED_AUTH_SESSION_JWT_SECRET)

	return c.json(
		{
			identity_id: identity.id,
			email: identity.email,
			session_token: sessionToken,
		},
		existing ? 200 : 201,
	)
})
