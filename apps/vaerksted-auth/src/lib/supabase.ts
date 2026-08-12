import { type SupabaseClient, createClient } from '@supabase/supabase-js'
import type { VaerkstedAuthEnv } from './env'

/**
 * Admin client construction for vaerksted-auth's dedicated Supabase project
 * (design doc §6a — "A new Supabase project dedicated to vaerksted-auth, not
 * Maskin's existing one"). Uses the service-role key because vaerksted-auth
 * itself verifies credentials/tokens server-side on behalf of callers
 * (Skjald, Maskin) — it is never a browser client, so RLS-bypassing
 * privileges are the intended posture here, not an accident.
 *
 * This repo has no real Supabase project credentials available in this
 * environment (dev sandbox), so this file cannot be exercised against a live
 * project — the shape below is written to be correct against a real
 * Supabase project's Auth admin API, per the `@supabase/supabase-js` v2
 * client contract.
 */
export function createSupabaseAdminClient(env: VaerkstedAuthEnv): SupabaseClient | null {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return null
	}
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: {
			// This is a trusted backend service account, not a browser session —
			// disable client-side session persistence/refresh entirely.
			autoRefreshToken: false,
			persistSession: false,
		},
	})
}

/** Thrown by route handlers that need Supabase configured but it isn't. */
export class SupabaseNotConfiguredError extends Error {
	constructor() {
		super('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured')
		this.name = 'SupabaseNotConfiguredError'
	}
}

/**
 * Returns a ready-to-use admin client or throws `SupabaseNotConfiguredError`.
 * Route handlers should catch this specifically (see `routes/identities.ts`
 * / `routes/sessions.ts`) and respond with a clear 503, never let it surface
 * as an unhandled crash.
 */
export function requireSupabaseAdminClient(env: VaerkstedAuthEnv): SupabaseClient {
	const client = createSupabaseAdminClient(env)
	if (!client) {
		throw new SupabaseNotConfiguredError()
	}
	return client
}
