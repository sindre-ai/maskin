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
