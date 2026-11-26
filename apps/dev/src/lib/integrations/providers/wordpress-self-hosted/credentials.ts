import { SafeFetchError, parseSafeUrl } from '../../safe-fetch'

/**
 * What is sealed for a self-hosted WordPress connection: one JSON document, so a site is one
 * credential row, one envelope and one audit trail. The application password lives only in here.
 */
export interface WordPressCredentials {
	/** The site's address as the customer typed it, cleaned: https, no trailing slash, no query. */
	site_url: string
	username: string
	application_password: string
	/** How the site's REST address is built, found at connect: pretty links or ?rest_route=. */
	rest_style: 'pretty' | 'query'
}

export const WORDPRESS_USERNAME_MAX_LENGTH = 256
export const WORDPRESS_PASSWORD_MAX_LENGTH = 256

export function encodeWordPressCredentials(c: WordPressCredentials): string {
	return JSON.stringify({
		site_url: c.site_url,
		username: c.username,
		application_password: c.application_password,
		rest_style: c.rest_style,
	})
}

/** The inverse of encodeWordPressCredentials. Null for anything that is not a well-formed value. */
export function decodeWordPressCredentials(value: string): WordPressCredentials | null {
	try {
		const parsed: unknown = JSON.parse(value)
		if (typeof parsed !== 'object' || parsed === null) return null
		const { site_url, username, application_password, rest_style } = parsed as Record<
			string,
			unknown
		>
		if (
			typeof site_url !== 'string' ||
			typeof username !== 'string' ||
			typeof application_password !== 'string'
		) {
			return null
		}
		return {
			site_url,
			username,
			application_password,
			rest_style: rest_style === 'query' ? 'query' : 'pretty',
		}
	} catch {
		return null
	}
}

/**
 * The site address as stored: the origin plus any folder the site lives in, with no query, no
 * fragment and no trailing slash. Throws SafeFetchError with a message fit to show the customer.
 * The host is not looked up here; every call to the site does that (safe-fetch.ts).
 */
export function normalizeSiteUrl(raw: string): string {
	const trimmed = raw.trim()
	// A bare "example.com" is what people type. https is the only scheme allowed, so add it.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
	const url = parseSafeUrl(withScheme)
	if (!url.hostname.includes('.') && !url.hostname.startsWith('[')) {
		throw new SafeFetchError('INVALID_URL', 'That is not a valid web address.')
	}
	const path = url.pathname.replace(/\/+$/, '')
	// A pasted admin or REST address means the folder before it.
	const folder = path.replace(/\/(wp-admin|wp-json)(\/.*)?$/i, '').replace(/\/wp-login\.php$/i, '')
	return `https://${url.host}${folder}`
}

/** The label shown for the connection and kept as its external id: the site's host and folder. */
export function siteLabel(siteUrl: string): string {
	return siteUrl.replace(/^https:\/\//, '')
}

/** WordPress shows an application password in groups of four with spaces; both forms work. */
export function cleanApplicationPassword(raw: string): string {
	return raw.replace(/\s+/g, '')
}
