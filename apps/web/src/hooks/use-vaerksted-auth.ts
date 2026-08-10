import { buildSignupCaptureKnowledge } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { type ActorWithKey, api } from '../lib/api'
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
	// Set when completeFromRedirect() lands on a brand-new actor — the
	// vaerksted handshake proves identity but never collects name/
	// organization/role the way the native /signup form does, so navigation
	// is held here until completeProfile() fills that gap. null in every
	// other case (login, or link-by-email to an existing actor that already
	// has this info).
	const [pendingProfile, setPendingProfile] = useState<ActorWithKey | null>(null)

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

			if (result.is_new_actor) {
				// Hold here instead of navigating — VaerkstedCompleteProfile
				// renders next and calls completeProfile() to finish up.
				setPendingProfile(result)
				return result
			}

			navigate({ to: '/' })
			return result
		} finally {
			setLoading(false)
		}
	}, [navigate])

	/**
	 * Finishes a brand-new-actor signup: renames the actor (it starts out
	 * named after its email, same fallback the backend uses), and writes the
	 * same "signup capture" knowledge object the native /signup form writes
	 * (packages/shared/src/schemas/signup-capture.ts) — org/role never get
	 * asked for anywhere else, and this is what the Strategist agent's
	 * research-on-signup trigger reads back. Best-effort on the knowledge
	 * write: a brand-new actor with a working name but a missing/failed
	 * knowledge object is still a fully usable account, unlike an actor with
	 * no workspace at all (the bug this whole flow exists to avoid).
	 */
	const completeProfile = useCallback(
		async (input: { name: string; organization: string; role: string }) => {
			if (!pendingProfile) return

			const name = input.name.trim()
			setLoading(true)
			try {
				await api.actors.update(pendingProfile.id, { name }, pendingProfile.workspace_id)
				setStoredActor({
					id: pendingProfile.id,
					name,
					type: pendingProfile.type,
					email: pendingProfile.email,
				})

				if (pendingProfile.workspace_id) {
					const knowledge = buildSignupCaptureKnowledge({
						name,
						organization: input.organization.trim(),
						role: input.role.trim(),
					})
					await api.objects.create(pendingProfile.workspace_id, knowledge).catch((err) => {
						console.error('[maskin] failed to write vaerksted signup capture knowledge', err)
					})
				}

				setPendingProfile(null)
				navigate({ to: '/' })
			} finally {
				setLoading(false)
			}
		},
		[pendingProfile, navigate],
	)

	return { loading, sendMagicLink, completeFromRedirect, pendingProfile, completeProfile }
}
