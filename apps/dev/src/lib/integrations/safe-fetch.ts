import { lookup } from 'node:dns/promises'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { isIP } from 'node:net'
import { isNonPublicAddress } from './public-host'

/**
 * The one way to call a host a customer typed (a WordPress site). It exists because the older
 * check, assertPublicHost, looks the name up, checks it, and then lets fetch look it up again: a
 * site that answers differently between the two lookups gets through. Here the name is resolved
 * once, every address it resolves to must be public, and the connection is made to that exact
 * address. The site name stays on the request, so the Host header and the certificate check are the
 * site's own.
 *
 * Also: https only, port 443 only, no redirects (a 3xx is refused, never followed), a timeout, and
 * a cap on how much of the reply is read.
 */

export const SAFE_FETCH_TIMEOUT_MS = 15_000
export const SAFE_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const SAFE_FETCH_MAX_REQUEST_BYTES = 512 * 1024

export type SafeFetchErrorCode =
	| 'INVALID_URL'
	| 'NOT_HTTPS'
	| 'PORT_NOT_ALLOWED'
	| 'HOST_NOT_FOUND'
	| 'HOST_NOT_PUBLIC'
	| 'REDIRECT_REFUSED'
	| 'RESPONSE_TOO_LARGE'
	| 'REQUEST_TOO_LARGE'
	| 'TIMEOUT'
	| 'CONNECTION_FAILED'

/** What went wrong, in a form that is safe to show: never a body, a header or a credential. */
export class SafeFetchError extends Error {
	constructor(
		readonly code: SafeFetchErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'SafeFetchError'
	}
}

export interface SafeFetchResult {
	status: number
	headers: Record<string, string>
	body: string
}

export interface SafeFetchInit {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	headers?: Record<string, string>
	body?: string
	timeoutMs?: number
	maxResponseBytes?: number
}

export interface SafeFetchDeps {
	/** Every address the name resolves to. Defaults to the system resolver. */
	resolve?: (host: string) => Promise<string[]>
	/** Defaults to node:https. */
	request?: typeof https.request
	/**
	 * Test seam: the address actually dialled instead of the checked one, so a local server can
	 * stand in for a public host. Production callers never pass it.
	 */
	dialAddress?: string
}

const defaultResolve = async (host: string): Promise<string[]> =>
	(await lookup(host, { all: true, verbatim: true })).map((r) => r.address)

/**
 * Resolves a host once and returns the address to connect to. Refuses unless every address the
 * name has is public, so a name that also answers with a private address is never used.
 */
export async function resolvePublicAddress(
	host: string,
	resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<string> {
	// new URL() keeps the brackets on an IPv6 literal.
	const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
	let addresses: string[]
	try {
		addresses = isIP(bare) ? [bare] : await resolve(bare)
	} catch {
		throw new SafeFetchError('HOST_NOT_FOUND', 'That address could not be found.')
	}
	const first = addresses[0]
	if (first === undefined) {
		throw new SafeFetchError('HOST_NOT_FOUND', 'That address could not be found.')
	}
	if (addresses.some(isNonPublicAddress)) {
		throw new SafeFetchError('HOST_NOT_PUBLIC', 'That address is not reachable from here.')
	}
	return first
}

/** Parses and checks the URL shape before any lookup: https, port 443, no login in the address. */
export function parseSafeUrl(raw: string): URL {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new SafeFetchError('INVALID_URL', 'That is not a valid web address.')
	}
	if (url.protocol !== 'https:') {
		throw new SafeFetchError('NOT_HTTPS', 'The address must start with https://.')
	}
	if (url.username || url.password) {
		throw new SafeFetchError('INVALID_URL', 'The address must not contain a login.')
	}
	if (url.port !== '' && url.port !== '443') {
		throw new SafeFetchError('PORT_NOT_ALLOWED', 'Only the standard https port (443) is allowed.')
	}
	return url
}

export async function safeFetch(
	rawUrl: string,
	init: SafeFetchInit = {},
	deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> {
	const url = parseSafeUrl(rawUrl)
	const checked = await resolvePublicAddress(url.hostname, deps.resolve)
	const address = deps.dialAddress ?? checked
	const family = isIP(address) === 6 ? 6 : 4

	const body = init.body
	if (body !== undefined && Buffer.byteLength(body) > SAFE_FETCH_MAX_REQUEST_BYTES) {
		throw new SafeFetchError('REQUEST_TOO_LARGE', 'The request is too large to send.')
	}
	const maxBytes = init.maxResponseBytes ?? SAFE_FETCH_MAX_RESPONSE_BYTES
	const timeoutMs = init.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS

	// The connection goes to the checked address and nowhere else: this replaces the second lookup.
	const pinned: LookupFunction = (_host, options, callback) => {
		if (options && typeof options === 'object' && options.all) {
			callback(null, [{ address, family }])
		} else {
			;(callback as (err: null, address: string, family: number) => void)(null, address, family)
		}
	}

	const request = deps.request ?? https.request
	const bareHost = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
	return new Promise<SafeFetchResult>((resolve, reject) => {
		let settled = false
		const fail = (err: SafeFetchError) => {
			if (settled) return
			settled = true
			req.destroy()
			reject(err)
		}
		const req = request(
			{
				host: bareHost,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: init.method ?? 'GET',
				// The site's own name stays on the request: Host header, TLS server name and certificate check.
				servername: isIP(bareHost) ? undefined : bareHost,
				headers: {
					Host: url.host,
					...init.headers,
					...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
				},
				lookup: pinned,
				timeout: timeoutMs,
			},
			(res) => {
				const status = res.statusCode ?? 0
				if (status >= 300 && status < 400) {
					res.resume()
					fail(new SafeFetchError('REDIRECT_REFUSED', 'The site answered with a redirect.'))
					return
				}
				const chunks: Buffer[] = []
				let size = 0
				res.on('data', (chunk: Buffer) => {
					size += chunk.length
					if (size > maxBytes) {
						res.destroy()
						fail(new SafeFetchError('RESPONSE_TOO_LARGE', 'The site answered with too much data.'))
						return
					}
					chunks.push(chunk)
				})
				res.on('end', () => {
					if (settled) return
					settled = true
					const headers: Record<string, string> = {}
					for (const [k, v] of Object.entries(res.headers)) {
						if (typeof v === 'string') headers[k] = v
						else if (Array.isArray(v)) headers[k] = v.join(', ')
					}
					resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
				})
				res.on('error', () =>
					fail(new SafeFetchError('CONNECTION_FAILED', 'The connection to the site broke.')),
				)
			},
		)
		req.on('timeout', () =>
			fail(new SafeFetchError('TIMEOUT', 'The site took too long to answer.')),
		)
		// Not the underlying error: it can carry the request.
		req.on('error', () =>
			fail(new SafeFetchError('CONNECTION_FAILED', 'The site could not be reached.')),
		)
		if (body !== undefined) req.write(body)
		req.end()
	})
}
