import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { api } from '../lib/api'
import { setApiKey, setStoredActor } from '../lib/auth'

/**
 * "Continue with vaerksted" — vaerksted-auth-and-sync.md §6/§8 and the
 * implementation plan's M5. Client-side half of the handshake:
 *
 *   1. Supabase magic-link sign-in against vaerksted-auth's OWN dedicated
 *      Supabase project (VITE_VAERKSTED_SUPABASE_URL/ANON_KEY — not
 *      Maskin's own Supabase usage, if any; design doc §6a).
 *   2. On return, exchange the resulting Supabase access token for a
 *      vaerksted-auth session_token via vaerksted-auth's own
 *      POST /identities (idempotent — upserts the identity either way, see
 *      apps/vaerksted-auth/src/routes/identities.ts).
 *   3. Exchange that session_token for a Maskin actor via
 *      POST /api/vaerksted-auth/link (apps/dev/src/routes/vaerksted-auth.ts)
 *      — server-side, this is the ONLY step that is trusted with identity;
 *      steps 1-2 just produce a token Maskin then verifies for itself.
 *
 * The `@supabase/supabase-js` client is created lazily and only if both env
 * vars are present, so a deployment that hasn't configured vaerksted-auth
 * yet degrades to a clear "not configured" error instead of a crash at
 * import time.
 */

// Loaded lazily (dynamic import) rather than a static import so a deployment
// that never configures vaerksted-auth doesn't pay for the dependency on
// every page load of the login/signup routes.
let supabaseClientPromise: Promise<import('@supabase/supabase-js').SupabaseClient | null> | null =
	null

function getVaerkstedSupabaseClient() {
	if (supabaseClientPromise) return supabaseClientPromise
	supabaseClientPromise = (async () => {
		const url = import.meta.env.VITE_VAERKSTED_SUPABASE_URL
		const anonKey = import.meta.env.VITE_VAERKSTED_SUPABASE_ANON_KEY
		if (!url || !anonKey) return null
		const { createClient } = await import('@supabase/supabase-js')
		return createClient(url, anonKey)
	})()
	return supabaseClientPromise
}

// Base URL for vaerksted-auth's own public API (its POST /identities), NOT
// Maskin's backend. Distinct from apps/dev's server-side VAERKSTED_AUTH_BASE_URL
// env var — this one is read by the browser, so it must be VITE_-prefixed per
// this app's existing convention (see VITE_POSTHOG_KEY / lib/posthog.ts).
function getVaerkstedAuthBaseUrl(): string | undefined {
	return import.meta.env.VITE_VAERKSTED_AUTH_BASE_URL
}

export function isVaerkstedAuthConfigured(): boolean {
	return Boolean(
		import.meta.env.VITE_VAERKSTED_SUPABASE_URL &&
			import.meta.env.VITE_VAERKSTED_SUPABASE_ANON_KEY &&
			getVaerkstedAuthBaseUrl(),
	)
}

export function useVaerkstedAuth() {
	const navigate = useNavigate()
	const [loading, setLoading] = useState(false)

	/** Step 1 — send the magic-link email. Errors on missing config or a bad email. */
	const sendMagicLink = useCallback(async (email: string) => {
		const client = await getVaerkstedSupabaseClient()
		const baseUrl = getVaerkstedAuthBaseUrl()
		if (!client || !baseUrl) {
			throw new Error('vaerksted sign-in is not configured')
		}
		setLoading(true)
		try {
			const { error } = await client.auth.signInWithOtp({
				email,
				options: { emailRedirectTo: window.location.href },
			})
			if (error) throw new Error(error.message)
		} finally {
			setLoading(false)
		}
	}, [])

	/**
	 * Steps 2-3 — called on mount of any page that can be a magic-link/OAuth
	 * redirect target. No-ops (resolves to `null`) when there's no pending
	 * Supabase session, which is the common case for a normal page load.
	 */
	const completeFromRedirect = useCallback(async () => {
		const client = await getVaerkstedSupabaseClient()
		const baseUrl = getVaerkstedAuthBaseUrl()
		if (!client || !baseUrl) return null

		const { data } = await client.auth.getSession()
		const accessToken = data.session?.access_token
		if (!accessToken) return null

		setLoading(true)
		try {
			const identitiesRes = await fetch(`${baseUrl.replace(/\/$/, '')}/identities`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ supabase_access_token: accessToken }),
			})
			if (!identitiesRes.ok) {
				throw new Error('Could not verify vaerksted identity')
			}
			const { session_token: sessionToken } = (await identitiesRes.json()) as {
				session_token: string
			}

			const result = await api.vaerkstedAuth.link(sessionToken)
			setApiKey(result.api_key)
			setStoredActor({
				id: result.id,
				name: result.name,
				type: result.type,
				email: result.email,
			})

			// The Supabase session was only a bridge to mint the vaerksted-auth
			// session_token above — Maskin now has its own `ank_` API key, so
			// don't keep a second, unrelated session sitting in the browser.
			await client.auth.signOut()

			navigate({ to: '/' })
			return result
		} finally {
			setLoading(false)
		}
	}, [navigate])

	return { loading, sendMagicLink, completeFromRedirect }
}
