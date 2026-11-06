import {
	MCP_OAUTH_PINNED_CLIENTS,
	OAUTH_SCOPE,
	type OauthAuthorizeErrorCode,
	type OauthAuthorizeParams,
	type PinnedMcpOAuthClient,
	stripTrailingSlash,
} from '@maskin/shared'
import { resolvePinnedClient } from './client-record'
import { resolveMcpResource, resolveOAuthIssuer } from './discovery'

type AuthorizeEnv = Parameters<typeof resolveMcpResource>[0]

/** A request that passed every check. redirectUri is the pinned string, not the request's copy. */
export interface AuthorizeRequest {
	client: PinnedMcpOAuthClient
	redirectUri: string
	codeChallenge: string
	state: string
	resource: string
}

export interface AuthorizeFailure {
	error: OauthAuthorizeErrorCode
	description: string
	/** Only for request-shape codes: a complete, verified link back to the client. */
	redirectUrl?: string
}

export type AuthorizeResult =
	| { ok: true; request: AuthorizeRequest }
	| { ok: false; failure: AuthorizeFailure }

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_MIN = 8
const STATE_MAX = 512
// Printable ASCII only. The same check guards state in every link the server builds.
const STATE_RE = /^[\x20-\x7e]+$/
const ALLOWED_SCOPES = new Set([OAUTH_SCOPE, 'offline_access'])

const DESCRIPTIONS: Record<OauthAuthorizeErrorCode, string> = {
	client_not_allowlisted: 'This app is not on the list of apps Maskin has approved',
	bad_redirect_uri: 'The return address does not match one this app registered',
	pkce_missing: 'The request has no PKCE code challenge',
	invalid_request: 'The request is missing a value or has a malformed one',
	unsupported_response_type: 'Only response_type code is supported',
	invalid_scope: 'The requested scope is not supported',
	invalid_target: 'The requested resource is not this server',
}

/** The error the client is sent back with. A missing PKCE challenge is a malformed request to RFC 6749. */
function oauthErrorFor(code: OauthAuthorizeErrorCode): string {
	return code === 'pkce_missing' ? 'invalid_request' : code
}

/** The one length and character check state passes before it may ride along in a link. */
export function isSafeState(state: string | undefined): state is string {
	return (
		state !== undefined &&
		state.length >= STATE_MIN &&
		state.length <= STATE_MAX &&
		STATE_RE.test(state)
	)
}

/**
 * Builds a link to the client from the pinned redirect string. The only request value that may
 * ride along is state, and only as an encoded query parameter, never in the host or path.
 */
function clientLink(
	pinnedRedirect: string,
	query: Array<[string, string]>,
	state: string | undefined,
	env: AuthorizeEnv,
): string {
	const url = new URL(pinnedRedirect)
	for (const [key, value] of query) url.searchParams.append(key, value)
	if (isSafeState(state)) url.searchParams.append('state', state)
	url.searchParams.append('iss', resolveOAuthIssuer(env))
	return url.toString()
}

/** Host of the matched pinned redirect, shown on the consent page (the MCP security rules ask for it). */
export function redirectHost(redirectUri: string): string {
	return new URL(redirectUri).host
}

function sameResource(requested: string | undefined, env: AuthorizeEnv): boolean {
	return (
		requested !== undefined &&
		stripTrailingSlash(requested) === stripTrailingSlash(resolveMcpResource(env))
	)
}

/**
 * Checks an authorize request in a fixed order: client_id, then redirect_uri (both exact match
 * against the pinned record), then everything else. A request that fails the first two gets an
 * identity code and no return link, whatever else is wrong with it. Request-shape failures carry
 * a link built from the pinned redirect so the page can offer "Back to Claude".
 */
export function validateAuthorizeRequest(
	params: OauthAuthorizeParams,
	env: AuthorizeEnv = process.env,
): AuthorizeResult {
	const resolved = resolvePinnedClient(params.client_id ?? '', params.redirect_uri ?? '')
	if (!resolved.ok) {
		return {
			ok: false,
			failure: { error: resolved.error, description: DESCRIPTIONS[resolved.error] },
		}
	}
	const { client } = resolved
	const pinnedRedirect = client.redirect_uris.find((uri) => uri === params.redirect_uri)
	if (!pinnedRedirect) {
		return {
			ok: false,
			failure: { error: 'bad_redirect_uri', description: DESCRIPTIONS.bad_redirect_uri },
		}
	}

	const shapeFailure = (error: OauthAuthorizeErrorCode): AuthorizeResult => ({
		ok: false,
		failure: {
			error,
			description: DESCRIPTIONS[error],
			redirectUrl: clientLink(pinnedRedirect, [['error', oauthErrorFor(error)]], params.state, env),
		},
	})

	if (params.response_type !== 'code') return shapeFailure('unsupported_response_type')
	if (!params.code_challenge || !params.code_challenge_method) return shapeFailure('pkce_missing')
	if (!CODE_CHALLENGE_RE.test(params.code_challenge) || params.code_challenge_method !== 'S256') {
		return shapeFailure('invalid_request')
	}
	if (!isSafeState(params.state)) return shapeFailure('invalid_request')
	if (!sameResource(params.resource, env)) return shapeFailure('invalid_target')
	if (params.scope) {
		const tokens = params.scope.split(/\s+/).filter(Boolean)
		if (tokens.length === 0 || !tokens.every((token) => ALLOWED_SCOPES.has(token))) {
			return shapeFailure('invalid_scope')
		}
	}

	return {
		ok: true,
		request: {
			client,
			redirectUri: pinnedRedirect,
			codeChallenge: params.code_challenge,
			state: params.state,
			resource: resolveMcpResource(env),
		},
	}
}

/** Where approve sends the browser: the client's redirect with the code, state and iss (RFC 9207). */
export function buildApproveRedirect(
	request: AuthorizeRequest,
	code: string,
	env: AuthorizeEnv = process.env,
): string {
	return clientLink(request.redirectUri, [['code', code]], request.state, env)
}

/** Where deny sends the browser: access_denied, state and iss. No database rows behind it. */
export function buildDenyRedirect(
	request: AuthorizeRequest,
	env: AuthorizeEnv = process.env,
): string {
	return clientLink(request.redirectUri, [['error', 'access_denied']], request.state, env)
}

/** The ids that may appear as client_id on the token endpoint. */
export function isPinnedClientId(clientId: string): boolean {
	return Object.hasOwn(MCP_OAUTH_PINNED_CLIENTS, clientId)
}

/** True when a requested resource names this server (one trailing slash ignored). */
export function isMcpResource(resource: string, env: AuthorizeEnv = process.env): boolean {
	return sameResource(resource, env)
}
