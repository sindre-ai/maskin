import { z } from 'zod'

// Plain z.object / z.enum only: the repo is moving to Zod 4, so no Zod-3-only helpers.

export const oauthTokenKindSchema = z.enum(['access', 'refresh'])
export type OauthTokenKind = z.infer<typeof oauthTokenKindSchema>

export const oauthRevokeReasonSchema = z.enum([
	'user',
	'member_removed',
	'code_reuse',
	'refresh_reuse',
	'pkce_failure',
	'admin',
])
export type OauthRevokeReason = z.infer<typeof oauthRevokeReasonSchema>

/** What a valid mat_ access token resolves to: the person, and the one workspace it is pinned to. */
export const oauthAccessTokenContextSchema = z.object({
	actorId: z.string().uuid(),
	type: z.string(),
	workspaceId: z.string().uuid(),
	grantId: z.string().uuid(),
	clientId: z.string(),
	scope: z.string(),
	resource: z.string(),
	expiresAt: z.date(),
})
export type OauthAccessTokenContext = z.infer<typeof oauthAccessTokenContextSchema>

// ── Authorize, token and grants routes ──────────────────────────────────────

/**
 * The seven reasons preview, approve and deny can refuse a request with. The first two are
 * identity codes: the request names a client or a return address Maskin does not know, so
 * nothing in it is trusted and no return link is ever sent. The other five are request-shape
 * codes, checked only after both identity checks passed.
 */
export const oauthAuthorizeErrorCodeSchema = z.enum([
	'client_not_allowlisted',
	'bad_redirect_uri',
	'pkce_missing',
	'invalid_request',
	'unsupported_response_type',
	'invalid_scope',
	'invalid_target',
])
export type OauthAuthorizeErrorCode = z.infer<typeof oauthAuthorizeErrorCodeSchema>

export const OAUTH_IDENTITY_ERROR_CODES: readonly OauthAuthorizeErrorCode[] = [
	'client_not_allowlisted',
	'bad_redirect_uri',
]

/**
 * The authorize request as it arrives on the consent page's address. Every field is optional
 * here on purpose: the server checks them in a fixed order and answers with one of the seven
 * codes above, which a generic validation failure would hide.
 */
export const oauthAuthorizeParamsSchema = z.object({
	response_type: z.string().optional(),
	client_id: z.string().optional(),
	redirect_uri: z.string().optional(),
	code_challenge: z.string().optional(),
	code_challenge_method: z.string().optional(),
	state: z.string().optional(),
	resource: z.string().optional(),
	scope: z.string().optional(),
})
export type OauthAuthorizeParams = z.infer<typeof oauthAuthorizeParamsSchema>

export const oauthApproveBodySchema = oauthAuthorizeParamsSchema.extend({
	workspace_id: z.string().uuid(),
})

export const oauthDenyBodySchema = oauthAuthorizeParamsSchema.extend({
	// The workspace the person had picked when they denied, if any. Used only for the funnel.
	workspace_id: z.string().uuid().optional(),
})

export const oauthPreviewResponseSchema = z.object({
	client: z.object({
		client_id: z.string(),
		client_name: z.string(),
		redirect_host: z.string(),
	}),
	workspaces: z.array(
		z.object({
			id: z.string().uuid(),
			name: z.string(),
			role: z.string(),
		}),
	),
	scope: z.string(),
})

/**
 * Error body of preview, approve and deny. redirect_url is absent (never null or empty) unless
 * the server verified a return address: only for the five request-shape codes.
 */
export const oauthErrorBodySchema = z.object({
	error: z.string(),
	error_description: z.string(),
	redirect_url: z.string().optional(),
})

export const oauthRedirectResponseSchema = z.object({ redirect_url: z.string() })

export const oauthTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.literal('Bearer'),
	expires_in: z.number().int(),
	refresh_token: z.string(),
	scope: z.string(),
})
export type OauthTokenResponse = z.infer<typeof oauthTokenResponseSchema>

export const oauthGrantSchema = z.object({
	id: z.string().uuid(),
	client_id: z.string(),
	client_name: z.string(),
	workspace_id: z.string().uuid(),
	workspace_name: z.string(),
	created_at: z.string(),
	last_used_at: z.string().nullable(),
})
export const oauthGrantListSchema = z.array(oauthGrantSchema)
export type OauthGrantRow = z.infer<typeof oauthGrantSchema>
