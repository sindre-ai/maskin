import { describe, expect, it } from 'vitest'
import {
	NATIVE_OAUTH_RETURN_URLS,
	buildNativeOAuthReturnUrl,
	parseNativeOAuthReturnUrl,
} from '../schemas/native-oauth-return'

describe('parseNativeOAuthReturnUrl', () => {
	it.each(NATIVE_OAUTH_RETURN_URLS)('accepts the allowlisted target %s', (url) => {
		expect(parseNativeOAuthReturnUrl(url)).toBe(url)
	})

	it.each([
		// other schemes
		'javascript:alert(1)',
		'data:text/html,<script>1</script>',
		'http://maskin.io/native/integrations/callback',
		'file:///etc/passwd',
		'otherapp://integrations/callback',
		// lookalike / subdomain / suffix hosts
		'https://maskin.io.evil.test/native/integrations/callback',
		'https://evilmaskin.io/native/integrations/callback',
		'https://app.maskin.io/native/integrations/callback',
		'https://maskin.io./native/integrations/callback',
		'https://MASKIN.IO/native/integrations/callback',
		'https://maskin.io:8443/native/integrations/callback',
		// userinfo tricks
		'https://maskin.io@evil.test/native/integrations/callback',
		'https://evil.test\\@maskin.io/native/integrations/callback',
		'https://maskin.io:pw@evil.test/native/integrations/callback',
		// path tricks / encoding
		'https://maskin.io/native/integrations/callback/',
		'https://maskin.io/native/integrations/callback/extra',
		'https://maskin.io/native/integrations/../../evil',
		'https://maskin.io/native/integrations/callback%2f..%2fevil',
		'https://maskin.io/native%2Fintegrations/callback',
		'https://maskin.io//evil.test/native/integrations/callback',
		'https://maskin.io/native/integrations/callback?next=https://evil.test',
		'https://maskin.io/native/integrations/callback#frag',
		'maskin://integrations/callback?x=1',
		'maskin://integrations/callback/extra',
		'maskin://evil/callback',
		'MASKIN://integrations/callback',
		'maskin:integrations/callback',
		'maskin:///integrations/callback',
		// whitespace / control characters
		' https://maskin.io/native/integrations/callback',
		'https://maskin.io/native/integrations/callback\n',
		'https://maskin.io/native/integrations/callback\u0000',
		'maskin://integrations/callback\t',
		// relative / protocol-relative / empty
		'//evil.test',
		'/native/integrations/callback',
		'',
		// non-strings
		null,
		undefined,
		42,
		{ href: 'maskin://integrations/callback' },
		['maskin://integrations/callback'],
	])('rejects %j', (raw) => {
		expect(parseNativeOAuthReturnUrl(raw)).toBeUndefined()
	})
})

describe('buildNativeOAuthReturnUrl', () => {
	it('encodes the outcome as query parameters on the allowlisted target', () => {
		const url = new URL(
			buildNativeOAuthReturnUrl('maskin://integrations/callback', {
				status: 'connected',
				provider: 'slack',
				workspaceId: 'ws-1',
				integrationId: 'int-1',
			}),
		)
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('maskin://integrations/callback')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			status: 'connected',
			provider: 'slack',
			workspace_id: 'ws-1',
			integration_id: 'int-1',
		})
	})

	it('carries reason and billing only when given', () => {
		const url = new URL(
			buildNativeOAuthReturnUrl('https://maskin.io/native/integrations/callback', {
				status: 'error',
				provider: 'github',
				reason: 'denied',
			}),
		)
		expect(url.searchParams.get('reason')).toBe('denied')
		expect(url.searchParams.has('billing')).toBe(false)
	})

	it('refuses to build for a target that is not allowlisted', () => {
		expect(() =>
			buildNativeOAuthReturnUrl('https://evil.test/x', { status: 'connected', provider: 'slack' }),
		).toThrow()
	})
})
