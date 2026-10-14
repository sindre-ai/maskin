import { MCP_OAUTH_CLAUDE_CLIENT_ID } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	buildApproveRedirect,
	buildDenyRedirect,
	isSafeState,
	redirectHost,
	validateAuthorizeRequest,
} from '../../lib/oauth-server/authorize'

const ENV = { MASKIN_OAUTH_ISSUER: 'https://maskin.test' }
const PINNED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

function validParams(overrides: Record<string, string | undefined> = {}) {
	return {
		response_type: 'code',
		client_id: MCP_OAUTH_CLAUDE_CLIENT_ID,
		redirect_uri: PINNED_REDIRECT,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: 'state-1234',
		resource: 'https://maskin.test/mcp',
		...overrides,
	}
}

function failureOf(overrides: Record<string, string | undefined>) {
	const result = validateAuthorizeRequest(validParams(overrides), ENV)
	if (result.ok) throw new Error('expected the request to be refused')
	return result.failure
}

describe('validateAuthorizeRequest', () => {
	it('accepts a complete request and carries the pinned redirect, not the request copy', () => {
		const result = validateAuthorizeRequest(validParams(), ENV)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.request.redirectUri).toBe(PINNED_REDIRECT)
		expect(result.request.resource).toBe('https://maskin.test/mcp')
		expect(result.request.client.client_name).toBe('Claude')
	})

	it('ignores one trailing slash on the resource and accepts offline_access in scope', () => {
		const result = validateAuthorizeRequest(
			validParams({ resource: 'https://maskin.test/mcp/', scope: 'mcp offline_access' }),
			ENV,
		)

		expect(result.ok).toBe(true)
	})

	describe('identity codes: no return link, whatever else is wrong', () => {
		it('refuses an unknown client_id with client_not_allowlisted', () => {
			const failure = failureOf({ client_id: 'https://evil.example/client.json' })

			expect(failure.error).toBe('client_not_allowlisted')
			expect(failure.redirectUrl).toBeUndefined()
		})

		it('refuses a redirect_uri that is not an exact match with bad_redirect_uri', () => {
			for (const redirect_uri of [
				'https://claude.ai/api/mcp/auth_callback/',
				'https://claude.ai/api/mcp/auth_callback?x=1',
				'https://evil.example/api/mcp/auth_callback',
				undefined,
			]) {
				const failure = failureOf({ redirect_uri })

				expect(failure.error).toBe('bad_redirect_uri')
				expect(failure.redirectUrl).toBeUndefined()
			}
		})

		it('a wrong client_id plus a missing PKCE challenge is client_not_allowlisted with no link', () => {
			const failure = failureOf({
				client_id: 'https://evil.example/client.json',
				code_challenge: undefined,
			})

			expect(failure.error).toBe('client_not_allowlisted')
			expect(failure.redirectUrl).toBeUndefined()
		})

		it('a hostile redirect_uri plus a missing PKCE challenge is bad_redirect_uri with no link', () => {
			const failure = failureOf({
				redirect_uri: 'https://evil.example/steal',
				code_challenge: undefined,
			})

			expect(failure.error).toBe('bad_redirect_uri')
			expect(failure.redirectUrl).toBeUndefined()
		})
	})

	describe('request-shape codes: a verified return link equal to the pinned redirect', () => {
		const cases: Array<[string, Record<string, string | undefined>, string]> = [
			['pkce_missing', { code_challenge: undefined }, 'invalid_request'],
			['pkce_missing', { code_challenge_method: undefined }, 'invalid_request'],
			['invalid_request', { code_challenge_method: 'plain' }, 'invalid_request'],
			['invalid_request', { code_challenge: 'too-short' }, 'invalid_request'],
			['invalid_request', { state: undefined }, 'invalid_request'],
			['invalid_request', { state: 'short' }, 'invalid_request'],
			['unsupported_response_type', { response_type: 'token' }, 'unsupported_response_type'],
			['invalid_scope', { scope: 'mcp admin' }, 'invalid_scope'],
			['invalid_target', { resource: 'https://other.example/mcp' }, 'invalid_target'],
			['invalid_target', { resource: undefined }, 'invalid_target'],
		]

		it.each(cases)('%s (%j) goes back as %s', (code, overrides, oauthError) => {
			const failure = failureOf(overrides)

			expect(failure.error).toBe(code)
			const link = new URL(failure.redirectUrl ?? '')
			expect(`${link.origin}${link.pathname}`).toBe(PINNED_REDIRECT)
			expect(link.searchParams.get('error')).toBe(oauthError)
			expect(link.searchParams.get('iss')).toBe('https://maskin.test')
		})

		it('carries a safe state as one encoded query parameter', () => {
			const failure = failureOf({ code_challenge: undefined, state: 'abcd1234&x=1' })

			const link = new URL(failure.redirectUrl ?? '')
			expect(link.searchParams.get('state')).toBe('abcd1234&x=1')
			expect(link.searchParams.getAll('x')).toEqual([])
		})

		it('leaves state out when it fails the length or character check', () => {
			for (const state of ['short', 'x'.repeat(513), 'has\nnewline-in-it']) {
				const failure = failureOf({ code_challenge: undefined, state })

				expect(new URL(failure.redirectUrl ?? '').searchParams.has('state')).toBe(false)
			}
		})

		it('never lets a hostile state reach the link host or path', () => {
			const hostile = '//evil.example/../../steal?x=1#frag'
			const failure = failureOf({ code_challenge: undefined, state: hostile })

			const link = new URL(failure.redirectUrl ?? '')
			expect(link.host).toBe('claude.ai')
			expect(link.pathname).toBe('/api/mcp/auth_callback')
			expect(link.hash).toBe('')
			expect(link.searchParams.get('state')).toBe(hostile)
		})

		it('builds the link from the pinned redirect, never from the request value', () => {
			// The request value only passes the identity check when it equals the pinned string,
			// so a different spelling is refused outright instead of being echoed.
			const failure = failureOf({ redirect_uri: 'https://claude.ai/api/mcp/auth_callback#x' })

			expect(failure.error).toBe('bad_redirect_uri')
			expect(failure.redirectUrl).toBeUndefined()
		})
	})
})

describe('redirects back to the client', () => {
	const request = () => {
		const result = validateAuthorizeRequest(validParams({ state: 'state 1234/+' }), ENV)
		if (!result.ok) throw new Error('expected a valid request')
		return result.request
	}

	it('approve carries code, state and iss, encoded', () => {
		const url = new URL(buildApproveRedirect(request(), 'the-code', ENV))

		expect(`${url.origin}${url.pathname}`).toBe(PINNED_REDIRECT)
		expect(url.searchParams.get('code')).toBe('the-code')
		expect(url.searchParams.get('state')).toBe('state 1234/+')
		expect(url.searchParams.get('iss')).toBe('https://maskin.test')
	})

	it('deny carries access_denied, state and iss and no code', () => {
		const url = new URL(buildDenyRedirect(request(), ENV))

		expect(url.searchParams.get('error')).toBe('access_denied')
		expect(url.searchParams.get('state')).toBe('state 1234/+')
		expect(url.searchParams.get('iss')).toBe('https://maskin.test')
		expect(url.searchParams.has('code')).toBe(false)
	})

	it('names the redirect host for the consent page', () => {
		expect(redirectHost(PINNED_REDIRECT)).toBe('claude.ai')
	})
})

describe('isSafeState', () => {
	it('accepts 8 to 512 printable ASCII characters', () => {
		expect(isSafeState('12345678')).toBe(true)
		expect(isSafeState('x'.repeat(512))).toBe(true)
	})

	it('refuses missing, short, long and non-printable values', () => {
		expect(isSafeState(undefined)).toBe(false)
		expect(isSafeState('1234567')).toBe(false)
		expect(isSafeState('x'.repeat(513))).toBe(false)
		expect(isSafeState('12345678\u0000')).toBe(false)
		expect(isSafeState('12345678é')).toBe(false)
	})
})
