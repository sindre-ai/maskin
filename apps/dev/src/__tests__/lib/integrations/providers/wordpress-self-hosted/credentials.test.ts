import { describe, expect, it } from 'vitest'
import {
	cleanApplicationPassword,
	decodeWordPressCredentials,
	encodeWordPressCredentials,
	normalizeSiteUrl,
	siteLabel,
} from '../../../../../lib/integrations/providers/wordpress-self-hosted/credentials'

describe('normalizeSiteUrl', () => {
	it('adds https, drops the trailing slash, query and fragment', () => {
		expect(normalizeSiteUrl('example.com')).toBe('https://example.com')
		expect(normalizeSiteUrl(' https://Example.com/?a=1#x ')).toBe('https://example.com')
		expect(normalizeSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog')
	})

	it('cuts a pasted admin or REST address back to the site', () => {
		expect(normalizeSiteUrl('https://example.com/wp-admin/profile.php')).toBe('https://example.com')
		expect(normalizeSiteUrl('https://example.com/blog/wp-json/wp/v2/posts')).toBe(
			'https://example.com/blog',
		)
		expect(normalizeSiteUrl('https://example.com/wp-login.php')).toBe('https://example.com')
	})

	it('refuses http, other ports, a login in the address and a bare word', () => {
		expect(() => normalizeSiteUrl('http://example.com')).toThrow('https')
		expect(() => normalizeSiteUrl('https://example.com:8443')).toThrow('443')
		expect(() => normalizeSiteUrl('https://me:pw@example.com')).toThrow('login')
		expect(() => normalizeSiteUrl('intranet')).toThrow('valid web address')
		expect(() => normalizeSiteUrl('ftp://example.com')).toThrow('https')
	})
})

describe('credentials encoding', () => {
	it('round-trips and rejects anything malformed', () => {
		const c = {
			site_url: 'https://example.com',
			username: 'editor',
			application_password: 'abcd efgh',
			rest_style: 'query' as const,
		}
		expect(decodeWordPressCredentials(encodeWordPressCredentials(c))).toEqual(c)
		expect(decodeWordPressCredentials('nope')).toBeNull()
		expect(decodeWordPressCredentials('{"site_url":"x"}')).toBeNull()
	})

	it('labels a site by its host and folder, and drops spaces from a password', () => {
		expect(siteLabel('https://example.com/blog')).toBe('example.com/blog')
		expect(cleanApplicationPassword('abcd EFGH  ijkl')).toBe('abcdEFGHijkl')
	})
})
