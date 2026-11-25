import { type SafeFetchInit, type SafeFetchResult, safeFetch } from '../../safe-fetch'
import { SafeFetchError } from '../../safe-fetch'
import type { WordPressCredentials } from './credentials'

/** The one function every site call goes through. Overridable in tests. */
export type SiteFetch = (url: string, init?: SafeFetchInit) => Promise<SafeFetchResult>

export type WordPressErrorCode =
	| 'NOT_REACHABLE'
	| 'NOT_HTTPS'
	| 'NOT_PUBLIC'
	| 'NOT_WORDPRESS'
	| 'REST_BLOCKED'
	| 'APP_PASSWORDS_OFF'
	| 'BAD_LOGIN'
	| 'NOT_ALLOWED'
	| 'NOT_FOUND'
	| 'RATE_LIMITED'
	| 'SITE_ERROR'
	| 'REQUEST_REFUSED'
	| 'UNEXPECTED_RESPONSE'
	| 'TOO_LARGE'

/** A failure with a code and a message that says what to do. Never carries a body or a header. */
export class WordPressError extends Error {
	constructor(
		readonly code: WordPressErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'WordPressError'
	}
}

const BLOCKED_HINT =
	'The site refused the request. Some hosts and security plugins block the REST address or application passwords; allow them for this site, then try again.'

/** Turns a transport failure into a message a person can act on. */
export function fromTransportError(err: unknown): WordPressError {
	if (err instanceof SafeFetchError) {
		switch (err.code) {
			case 'NOT_HTTPS':
			case 'PORT_NOT_ALLOWED':
			case 'INVALID_URL':
				return new WordPressError('NOT_HTTPS', err.message)
			case 'HOST_NOT_PUBLIC':
				return new WordPressError('NOT_PUBLIC', err.message)
			case 'HOST_NOT_FOUND':
				return new WordPressError('NOT_REACHABLE', "The site's address could not be found.")
			case 'REDIRECT_REFUSED':
				return new WordPressError(
					'REQUEST_REFUSED',
					'The site redirected the request. Use the address the site really lives at (for example with or without www, and with https).',
				)
			case 'RESPONSE_TOO_LARGE':
				return new WordPressError('TOO_LARGE', 'The site answered with more data than is read.')
			case 'REQUEST_TOO_LARGE':
				return new WordPressError('TOO_LARGE', 'The text is too large to send.')
			case 'TIMEOUT':
				return new WordPressError('NOT_REACHABLE', 'The site took too long to answer.')
			default:
				return new WordPressError(
					'NOT_REACHABLE',
					'The site could not be reached over https. Check that it is online and that its certificate is valid.',
				)
		}
	}
	return new WordPressError('NOT_REACHABLE', 'The site could not be reached.')
}

export function basicAuthHeader(
	c: Pick<WordPressCredentials, 'username' | 'application_password'>,
) {
	return `Basic ${Buffer.from(`${c.username}:${c.application_password}`).toString('base64')}`
}

/** The site's REST address for a route like "wp/v2/posts", in the style the site answers to. */
export function restUrl(
	site: Pick<WordPressCredentials, 'site_url' | 'rest_style'>,
	route: string,
	query: Record<string, string | number | undefined> = {},
): string {
	const params = new URLSearchParams()
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined) params.set(k, String(v))
	}
	const extra = params.toString()
	if (site.rest_style === 'query') {
		return `${site.site_url}/?rest_route=${encodeURIComponent(`/${route}`)}${extra ? `&${extra}` : ''}`
	}
	return `${site.site_url}/wp-json/${route}${extra ? `?${extra}` : ''}`
}

function parseJson(res: SafeFetchResult): unknown {
	try {
		return JSON.parse(res.body)
	} catch {
		return undefined
	}
}

/** WordPress' own error code ("rest_not_logged_in") from an error body, nothing else from it. */
function wpErrorCode(body: unknown): string | null {
	if (typeof body !== 'object' || body === null) return null
	const code = (body as { code?: unknown }).code
	return typeof code === 'string' ? code.slice(0, 80) : null
}

/** Maps a non-2xx answer to an error. The body is read only for WordPress' error code. */
export function failureForResponse(res: SafeFetchResult): WordPressError {
	const code = wpErrorCode(parseJson(res))
	const { status } = res
	if (status === 401) {
		if (code === 'incorrect_password' || code === 'invalid_username') {
			return new WordPressError(
				'BAD_LOGIN',
				'WordPress did not accept this username and application password. Check them and try again.',
			)
		}
		return new WordPressError(
			'BAD_LOGIN',
			'WordPress did not accept the sign-in. Check the username and application password. If both are right, the host may strip the Authorization header or a security plugin may block application passwords.',
		)
	}
	if (status === 403) {
		if (code?.startsWith('rest_')) {
			return new WordPressError(
				'NOT_ALLOWED',
				'This WordPress user may not do that. Use a user with the rights for the action (for example Editor).',
			)
		}
		return new WordPressError('REST_BLOCKED', BLOCKED_HINT)
	}
	if (status === 404) {
		if (code === 'rest_no_route') {
			return new WordPressError('NOT_FOUND', 'The site has no such REST route.')
		}
		if (code === 'rest_post_invalid_id' || code === 'rest_invalid_id') {
			return new WordPressError('NOT_FOUND', 'No item with that id on the site.')
		}
		return new WordPressError(
			'NOT_WORDPRESS',
			'This address does not look like a WordPress site with the REST address turned on.',
		)
	}
	if (status === 429)
		return new WordPressError('RATE_LIMITED', 'The site is limiting requests. Try again later.')
	if (status >= 500)
		return new WordPressError('SITE_ERROR', 'The site had an error. Try again later.')
	if (status === 400 || status === 422) {
		return new WordPressError('REQUEST_REFUSED', 'The site refused the values sent.')
	}
	return new WordPressError(
		'REQUEST_REFUSED',
		`The site answered with an unexpected status (${status}).`,
	)
}

export interface WpResult {
	status: number
	json: unknown
	/** The site's own paging totals, when it sent them. */
	total: number | null
	totalPages: number | null
}

/** One authenticated call to the site's REST address. Throws WordPressError, never returns a failure. */
export async function wpCall(
	creds: WordPressCredentials,
	route: string,
	opts: {
		method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
		query?: Record<string, string | number | undefined>
		body?: unknown
	} = {},
	fetchImpl: SiteFetch = safeFetch,
): Promise<WpResult> {
	let res: SafeFetchResult
	try {
		res = await fetchImpl(restUrl(creds, route, opts.query), {
			method: opts.method ?? 'GET',
			headers: {
				Authorization: basicAuthHeader(creds),
				Accept: 'application/json',
				...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
		})
	} catch (err) {
		throw fromTransportError(err)
	}
	if (res.status < 200 || res.status >= 300) throw failureForResponse(res)
	const json = parseJson(res)
	if (json === undefined) {
		throw new WordPressError(
			'UNEXPECTED_RESPONSE',
			'The site answered with something that is not JSON. A security plugin or a redirect page may be in the way.',
		)
	}
	const num = (v: string | undefined) => {
		const n = Number(v)
		return v !== undefined && Number.isFinite(n) ? n : null
	}
	return {
		status: res.status,
		json,
		total: num(res.headers['x-wp-total']),
		totalPages: num(res.headers['x-wp-totalpages']),
	}
}

export interface SiteInfo {
	rest_style: 'pretty' | 'query'
	name: string | null
	/** False when the site's index lists no application-password sign-in. Null when it was not readable. */
	application_passwords: boolean | null
}

/**
 * Finds how the site answers on its REST address, without signing in. Pretty links first
 * (/wp-json/), then the plain form (?rest_route=). A site whose index is hidden by a security
 * plugin is not a failure here: the signed-in check that follows says what is wrong.
 */
export async function discoverSite(
	siteUrl: string,
	fetchImpl: SiteFetch = safeFetch,
): Promise<SiteInfo> {
	const attempts: Array<{ style: 'pretty' | 'query'; url: string }> = [
		{ style: 'pretty', url: `${siteUrl}/wp-json/` },
		{ style: 'query', url: `${siteUrl}/?rest_route=/` },
	]
	let transport: WordPressError | null = null
	let sawBlock = false
	for (const attempt of attempts) {
		let res: SafeFetchResult
		try {
			res = await fetchImpl(attempt.url, { headers: { Accept: 'application/json' } })
		} catch (err) {
			// The same host failing the same way twice is not a second chance; say what it was.
			transport = fromTransportError(err)
			break
		}
		if (res.status === 401 || res.status === 403) {
			sawBlock = true
			continue
		}
		if (res.status !== 200) continue
		const json = parseJson(res) as
			| { name?: unknown; namespaces?: unknown; authentication?: unknown }
			| undefined
		if (!json || typeof json !== 'object' || !Array.isArray(json.namespaces)) continue
		const auth = json.authentication
		return {
			rest_style: attempt.style,
			name: typeof json.name === 'string' ? json.name.slice(0, 200) : null,
			application_passwords:
				auth && typeof auth === 'object' && !Array.isArray(auth)
					? 'application-passwords' in (auth as object)
					: false,
		}
	}
	if (transport) throw transport
	if (sawBlock) throw new WordPressError('REST_BLOCKED', BLOCKED_HINT)
	throw new WordPressError(
		'NOT_WORDPRESS',
		'This address does not look like a WordPress site with the REST address turned on.',
	)
}

export interface WhoAmI {
	id: number
	name: string | null
	can_edit_posts: boolean
}

/** Signs in once and says who the site thinks this is. Used at connect and by the check tool. */
export async function whoAmI(
	creds: WordPressCredentials,
	fetchImpl: SiteFetch = safeFetch,
): Promise<WhoAmI> {
	const { json } = await wpCall(creds, 'wp/v2/users/me', { query: { context: 'edit' } }, fetchImpl)
	const me = json as { id?: unknown; name?: unknown; capabilities?: Record<string, unknown> }
	if (typeof me?.id !== 'number') {
		throw new WordPressError('UNEXPECTED_RESPONSE', 'The site did not say who is signed in.')
	}
	return {
		id: me.id,
		name: typeof me.name === 'string' ? me.name.slice(0, 200) : null,
		can_edit_posts: me.capabilities?.edit_posts === true,
	}
}
