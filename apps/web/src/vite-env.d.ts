/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_POSTHOG_KEY?: string
	readonly VITE_POSTHOG_HOST?: string
	// vaerksted-auth's dedicated Supabase project (vaerksted-auth-and-sync.md
	// §6a) — NOT Maskin's own Supabase usage, if any. Used only for the
	// client-side magic-link/OAuth flow; the resulting Supabase access token
	// is exchanged for a vaerksted-auth session server-side, never used
	// directly against Maskin's API. See hooks/use-vaerksted-auth.ts.
	readonly VITE_VAERKSTED_SUPABASE_URL?: string
	readonly VITE_VAERKSTED_SUPABASE_ANON_KEY?: string
	// vaerksted-auth's own public base URL, reachable from the browser (its
	// POST /identities) — distinct from apps/dev's server-side
	// VAERKSTED_AUTH_BASE_URL, which apps/dev uses for its own
	// server-to-server GET /sessions/me call.
	readonly VITE_VAERKSTED_AUTH_BASE_URL?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
