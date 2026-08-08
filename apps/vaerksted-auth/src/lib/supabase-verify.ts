import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * ── Assumed Supabase Auth client-side contract (documented, not verified
 * against a live project — this dev environment has no real Supabase
 * credentials) ──
 *
 * Design doc §6a: "client calls vaerksted-auth's own POST /identities /
 * POST /sessions; vaerksted-auth calls Supabase Auth to actually verify the
 * credential or complete the OAuth/SSO handshake." The concrete shape this
 * implementation assumes:
 *
 * 1. The Skjald/Maskin client uses the Supabase JS client SDK directly
 *    (`@supabase/supabase-js`, browser/Tauri build) against vaerksted-auth's
 *    dedicated Supabase project to complete whichever credential flow the
 *    user picked — magic link (`signInWithOtp`), Google/Microsoft OAuth
 *    (`signInWithOAuth`). This is the "OAuth *client* role" from §6a;
 *    Supabase Auth already implements it correctly, so vaerksted-auth's own
 *    backend never needs to speak OAuth to Google/Microsoft directly.
 * 2. That flow ends with the client holding a genuine Supabase **access
 *    token** (a JWT minted by GoTrue for the now-authenticated
 *    `auth.users` row).
 * 3. The client then calls vaerksted-auth's `POST /identities` (first time)
 *    or `POST /sessions` (subsequent logins) with body
 *    `{ supabase_access_token: string }`.
 * 4. vaerksted-auth verifies that token using its own service-role admin
 *    client (`supabase.auth.getUser(token)`), which validates the JWT
 *    server-side and returns the corresponding `auth.users` row — this is
 *    the standard `@supabase/supabase-js` v2 pattern for a backend
 *    verifying a token it did not itself mint. No JWT-verification code is
 *    hand-rolled here; Supabase's SDK owns that.
 *
 * If a live Supabase project reveals a different actual shape (e.g. the
 * client should instead send Supabase's `refresh_token` for a
 * server-side exchange, or an OAuth `code` for a PKCE code exchange
 * vaerksted-auth performs itself), this function is the single place to
 * change — every route in `routes/` calls through it rather than talking to
 * `SupabaseClient` directly.
 */
export type VerifiedSupabaseUser = {
	supabaseUserId: string
	email: string | null
}

export class InvalidSupabaseTokenError extends Error {
	constructor(cause?: unknown) {
		super('Supabase access token is invalid or expired')
		this.name = 'InvalidSupabaseTokenError'
		this.cause = cause
	}
}

export async function verifySupabaseAccessToken(
	client: SupabaseClient,
	accessToken: string,
): Promise<VerifiedSupabaseUser> {
	const { data, error } = await client.auth.getUser(accessToken)
	if (error || !data.user) {
		throw new InvalidSupabaseTokenError(error)
	}
	return { supabaseUserId: data.user.id, email: data.user.email ?? null }
}
