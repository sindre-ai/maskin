import type { OauthAuthorizeErrorCode } from '@maskin/shared'
import { oauthClientLabel } from '../analytics/mcp-client'
import { capturePosthogEvent } from '../analytics/posthog'
import { isPinnedClientId } from './authorize'

// Server-side funnel events for the Claude connector, sent from the route that makes each
// decision. The consent page sends nothing, and nothing is sent before sign-in: the page is a
// web route and preview needs a signed-in person, so no server route sees anyone earlier.
//
// Every event carries client (the fixed label for the pinned client, claude_ai). Properties are a
// closed set of ids, counts and reasons. Never a token, code, state, code challenge, verifier,
// redirect URI or hash.

export const OAUTH_EVENTS = {
	authorizeStarted: 'mcp_oauth_authorize_started',
	previewRejected: 'mcp_oauth_preview_rejected',
	consentApproved: 'mcp_oauth_consent_approved',
	consentDenied: 'mcp_oauth_consent_denied',
	tokenIssued: 'mcp_oauth_token_issued',
	tokenRefreshed: 'mcp_oauth_token_refreshed',
	tokenRejected: 'mcp_oauth_token_rejected',
	refreshReuseRevoked: 'oauth_refresh_reuse_revoked',
} as const

/** Why preview refused: the seven request codes, or the per-person limit. */
export type PreviewRejectedReason = OauthAuthorizeErrorCode | 'rate_limited'

/** Why the token endpoint refused. Refresh reuse is not here: it has its own event. */
export type TokenRejectedReason =
	| 'invalid_request'
	| 'unsupported_grant_type'
	| 'code_unknown_or_expired'
	| 'code_reuse'
	| 'pkce_failed'
	| 'redirect_mismatch'
	| 'resource_mismatch'
	| 'refresh_unknown_or_expired'
	| 'refresh_revoked'
	| 'rate_limited'

/** The one distinct id for a token refusal where no grant resolved. A bucket, not a person. */
export const OAUTH_UNRESOLVED_DISTINCT_ID = 'oauth-unresolved'

type Properties = Record<string, string | number | boolean>

/** client is the label for the pinned client only; an unknown client_id never becomes a property. */
function clientProps(clientId: string | undefined): Properties {
	return clientId && isPinnedClientId(clientId) ? { client: oauthClientLabel(clientId) } : {}
}

function send(event: string, distinctId: string, properties: Properties): void {
	// capturePosthogEvent never throws and never blocks the request.
	void capturePosthogEvent(event, distinctId, properties)
}

/** Preview succeeded, so the consent page was shown. The funnel starts here. */
export function captureAuthorizeStarted(input: {
	actorId: string
	clientId: string
	workspaceCount: number
}): void {
	send(OAUTH_EVENTS.authorizeStarted, input.actorId, {
		...clientProps(input.clientId),
		workspace_count: input.workspaceCount,
	})
}

export function capturePreviewRejected(input: {
	actorId: string
	clientId?: string
	reason: PreviewRejectedReason
}): void {
	send(OAUTH_EVENTS.previewRejected, input.actorId, {
		...clientProps(input.clientId),
		reason: input.reason,
	})
}

export function captureConsentApproved(input: {
	actorId: string
	clientId: string
	workspaceId: string
	grantId: string
}): void {
	send(OAUTH_EVENTS.consentApproved, input.actorId, {
		...clientProps(input.clientId),
		workspace_id: input.workspaceId,
		grant_id: input.grantId,
	})
}

export function captureConsentDenied(input: {
	actorId: string
	clientId: string
	workspaceId?: string
}): void {
	send(OAUTH_EVENTS.consentDenied, input.actorId, {
		...clientProps(input.clientId),
		...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
	})
}

/** The first token pair for a connection: the code was traded. */
export function captureTokenIssued(input: {
	actorId: string
	clientId: string
	workspaceId: string
	grantId: string
}): void {
	send(OAUTH_EVENTS.tokenIssued, input.actorId, {
		...clientProps(input.clientId),
		workspace_id: input.workspaceId,
		grant_id: input.grantId,
		grant_type: 'authorization_code',
	})
}

export function captureTokenRefreshed(input: {
	actorId: string
	clientId: string
	workspaceId: string
	grantId: string
}): void {
	send(OAUTH_EVENTS.tokenRefreshed, input.actorId, {
		...clientProps(input.clientId),
		workspace_id: input.workspaceId,
		grant_id: input.grantId,
	})
}

/** The token endpoint refused. Attributed to the grant's owner when a grant resolved. */
export function captureTokenRejected(input: {
	reason: TokenRejectedReason
	clientId?: string
	actorId?: string
	grantId?: string
}): void {
	const properties: Properties = { ...clientProps(input.clientId), reason: input.reason }
	if (input.grantId) properties.grant_id = input.grantId
	if (input.actorId) {
		send(OAUTH_EVENTS.tokenRejected, input.actorId, properties)
		return
	}
	// No person to attribute it to: a fixed bucket id that creates no PostHog person.
	send(OAUTH_EVENTS.tokenRejected, OAUTH_UNRESOLVED_DISTINCT_ID, {
		...properties,
		$process_person_profile: false,
	})
}

/**
 * A refresh token presented a second time ended its whole connection. Counted so the CTO can
 * see whether Claude's retries trip the no-grace rule.
 */
export function captureRefreshReuseRevoked(input: {
	actorId: string
	grantId: string
	clientId: string
	grantAgeSeconds: number
	secondsSinceFirstUse: number
}): void {
	send(OAUTH_EVENTS.refreshReuseRevoked, input.actorId, {
		...clientProps(input.clientId),
		grant_id: input.grantId,
		grant_age_s: input.grantAgeSeconds,
		seconds_since_first_use: input.secondsSinceFirstUse,
	})
}
