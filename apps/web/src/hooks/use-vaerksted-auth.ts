import { buildSignupCaptureKnowledge } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { api } from '../lib/api'
import { getStoredActor, setApiKey, setStoredActor } from '../lib/auth'

/**
 * "Continue with vaerksted" — vaerksted-auth-and-sync.md §6/§8 and the
 * implementation plan's M5. Now the ONLY sign-in/sign-up path in
 * apps/web (native password auth was removed from the UI — see
 * routes/login.tsx and routes/signup.tsx). Client-side half of the
 * handshake:
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

export interface VaerkstedProfileInput {
	name: string
	organization: string
	role: string
}

// Name/organization/role, collected inline on /signup *before* the magic
// link is sent (matching the pre-vaerksted native signup form's layout — no
// post-redirect popup). The magic-link click very often opens in a new
// tab/window (email clients, OS link handling), so this must survive across
// tabs on the same origin — sessionStorage would not, localStorage does.
// Same pattern as the pre-existing maskin_pending_prompt/maskin_anon_id
// landing-page handoff keys just below in routes/signup.tsx. Cleared as soon
// as it's consumed (or found irrelevant, e.g. an existing-actor login) so a
// stale profile never leaks into an unrelated later signup.
//
// If nothing was stashed — the /login page never collects these fields, so a
// brand-new actor who typed a never-before-seen email into /login has none —
// completeFromRedirect() below routes to /complete-profile instead of
// silently defaulting the actor's name to their email.
const PENDING_PROFILE_KEY = 'maskin_vaerksted_pending_profile'

function stashPendingProfile(profile: VaerkstedProfileInput): void {
	try {
		localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(profile))
	} catch (err) {
		console.error('[maskin] failed to stash vaerksted signup profile', err)
	}
}

function takePendingProfile(): VaerkstedProfileInput | null {
	try {
		const raw = localStorage.getItem(PENDING_PROFILE_KEY)
		localStorage.removeItem(PENDING_PROFILE_KEY)
		if (!raw) return null
		const parsed = JSON.parse(raw)
		if (
			typeof parsed?.name === 'string' &&
			typeof parsed?.organization === 'string' &&
			typeof parsed?.role === 'string'
		) {
			return parsed
		}
		return null
	} catch (err) {
		console.error('[maskin] failed to read stashed vaerksted signup profile', err)
		return null
	}
}

/**
 * Renames the actor from its email-placeholder name and writes the same
 * "signup capture" knowledge object the native /signup form used to write
 * (packages/shared/src/schemas/signup-capture.ts) — org/role are otherwise
 * never captured anywhere, and this is what the Strategist agent's
 * research-on-signup trigger reads back. Does NOT navigate — callers decide
 * when. Best-effort on the knowledge write: a brand-new actor with a working
 * name but a missing/failed knowledge object is still a fully usable
 * account, unlike an actor with no workspace at all (a previously-fixed bug
 * this flow must not reintroduce).
 */
async function applyProfile(
	actor: { id: string; type: string; email: string | null },
	workspaceId: string | undefined,
	profile: VaerkstedProfileInput,
): Promise<void> {
	const name = profile.name.trim()
	if (!name) return

	await api.actors.update(actor.id, { name }, workspaceId)
	setStoredActor({ id: actor.id, name, type: actor.type, email: actor.email })

	if (workspaceId) {
		const knowledge = buildSignupCaptureKnowledge({
			name,
			organization: profile.organization.trim(),
			role: profile.role.trim(),
		})
		await api.objects.create(workspaceId, knowledge).catch((err) => {
			console.error('[maskin] failed to write vaerksted signup capture knowledge', err)
		})
	}
}

export function useVaerkstedAuth() {
	const navigate = useNavigate()
	const [loading, setLoading] = useState(false)

	/**
	 * Step 1 — send the magic-link email. `profile` is only meaningful for a
	 * signup (routes/signup.tsx) — pass it and it's stashed for
	 * completeFromRedirect() to apply automatically if this turns out to be a
	 * brand-new actor; omit it for a plain login (routes/login.tsx), which
	 * never collects it.
	 */
	const sendMagicLink = useCallback(async (email: string, profile?: VaerkstedProfileInput) => {
		const client = await getVaerkstedSupabaseClient()
		const baseUrl = getVaerkstedAuthBaseUrl()
		if (!client || !baseUrl) {
			throw new Error('vaerksted sign-in is not configured')
		}
		setLoading(true)
		try {
			if (profile) {
				stashPendingProfile(profile)
			}
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
	 * Callers (routes/login.tsx, routes/signup.tsx) can inspect the resolved
	 * actor's `is_new_actor` for their own page-specific post-signup side
	 * effects (analytics, landing-page handoff) — this function only owns
	 * the identity handshake + profile application + navigation.
	 *
	 * Three outcomes for where a brand-new actor's name/organization/role
	 * come from:
	 *   1. Stashed from /signup → applied automatically here, straight to '/'.
	 *   2. Nothing stashed (e.g. a new email typed into /login) → routed to
	 *      /complete-profile, a full page asking the same three questions
	 *      (routes/_authed/complete-profile.tsx) — deliberately NOT a
	 *      post-redirect popup.
	 *   3. Not a new actor at all (login/link-by-email) → straight to '/',
	 *      any stale stash from an earlier abandoned signup discarded.
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
				const stashed = takePendingProfile()
				if (stashed) {
					await applyProfile(result, result.workspace_id, stashed)
				} else {
					navigate({ to: '/complete-profile', search: { workspace_id: result.workspace_id } })
					return result
				}
			} else {
				// Not a new actor (login, or link-by-email) — any stashed profile
				// from an unrelated/earlier signup attempt is stale, discard it
				// rather than let it leak into a future signup.
				takePendingProfile()
			}

			navigate({ to: '/' })
			return result
		} finally {
			setLoading(false)
		}
	}, [navigate])

	/**
	 * Called from routes/_authed/complete-profile.tsx once the user answers
	 * the three questions completeFromRedirect() couldn't ask automatically.
	 * By this point the actor is already authenticated (setApiKey/
	 * setStoredActor already ran) — reads it back via getStoredActor() rather
	 * than needing it passed in.
	 */
	const submitProfile = useCallback(
		async (workspaceId: string | undefined, profile: VaerkstedProfileInput) => {
			const actor = getStoredActor()
			if (!actor) {
				navigate({ to: '/login' })
				return
			}
			setLoading(true)
			try {
				await applyProfile(actor, workspaceId, profile)
				navigate({ to: '/' })
			} finally {
				setLoading(false)
			}
		},
		[navigate],
	)

	return { loading, sendMagicLink, completeFromRedirect, submitProfile }
}
