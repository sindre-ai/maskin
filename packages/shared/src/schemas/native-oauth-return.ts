import { z } from 'zod'

// ── Native (app) return target for the integration connect flow ─────────────
//
// A native app runs the connect flow in an ASWebAuthenticationSession. When the
// provider callback finishes, the browser session is sent to one of the URLs
// below, with the outcome in the query string, instead of to the web settings
// page. The target is attacker-influenced input that ends up in a 302, so it is
// NEVER parsed or rewritten: a value is accepted only when it is byte-for-byte
// equal to an entry in this list. That makes lookalike hosts, userinfo
// (`maskin.io@evil.test`), port/case/encoding tricks and extra path segments or
// query strings unrepresentable, instead of something a URL parser has to catch.

/** The only return targets a connect flow may name. Exact match, no query/fragment. */
export const NATIVE_OAUTH_RETURN_URLS = [
	'maskin://integrations/callback',
	'https://maskin.io/native/integrations/callback',
] as const

export const nativeOAuthReturnUrlSchema = z
	.string()
	.refine((v) => (NATIVE_OAUTH_RETURN_URLS as readonly string[]).includes(v), {
		message: 'native_return_url is not an allowed return target',
	})

/** The value if it is an allowed native return target, otherwise `undefined`. */
export function parseNativeOAuthReturnUrl(raw: unknown): string | undefined {
	const parsed = nativeOAuthReturnUrlSchema.safeParse(raw)
	return parsed.success ? parsed.data : undefined
}

/**
 * `connected`          — the integration is active.
 * `selection_required` — GitHub only: the user can reach several installations;
 *                        the app finishes with `POST /api/integrations/github/select-installation`.
 * `error`              — see `reason`.
 */
export const nativeOAuthStatusSchema = z.enum(['connected', 'selection_required', 'error'])
export type NativeOAuthStatus = z.infer<typeof nativeOAuthStatusSchema>

export const nativeOAuthErrorReasonSchema = z.enum([
	'denied',
	'state_expired',
	'invalid_state',
	'not_bound',
	'not_member',
	'missing_code',
	'token_exchange_failed',
	'installation_unauthorized',
	'post_install_failed',
	'people_id_fetch_failed',
	'enumeration_failed',
	'account_restricted',
	'unsupported',
	'unknown',
])
export type NativeOAuthErrorReason = z.infer<typeof nativeOAuthErrorReasonSchema>

export interface NativeOAuthOutcome {
	status: NativeOAuthStatus
	provider: string
	workspaceId?: string
	integrationId?: string
	reason?: NativeOAuthErrorReason
	/** LinkedIn only: connected, but the add-on still needs checkout on the web. */
	billing?: 'required'
}

/**
 * Build the URL the browser session is redirected to. `returnUrl` is re-checked
 * against the allowlist. Carries identifiers and a status only — never a token,
 * credential, authorization code or OAuth state.
 */
export function buildNativeOAuthReturnUrl(returnUrl: string, outcome: NativeOAuthOutcome): string {
	const base = parseNativeOAuthReturnUrl(returnUrl)
	if (!base) throw new Error('Not an allowed native return target')
	const params = new URLSearchParams()
	params.set('status', outcome.status)
	params.set('provider', outcome.provider)
	if (outcome.workspaceId) params.set('workspace_id', outcome.workspaceId)
	if (outcome.integrationId) params.set('integration_id', outcome.integrationId)
	if (outcome.reason) params.set('reason', outcome.reason)
	if (outcome.billing) params.set('billing', outcome.billing)
	return `${base}?${params.toString()}`
}
