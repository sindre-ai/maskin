import { createServer } from 'node:http'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	SAFE_FETCH_MAX_REQUEST_BYTES,
	SafeFetchError,
	parseSafeUrl,
	resolvePublicAddress,
	safeFetch,
} from '../../../lib/integrations/safe-fetch'

const PUBLIC = '93.184.216.34'
const answer =
	(...addresses: string[]) =>
	async () =>
		addresses

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p
	} catch (err) {
		if (err instanceof SafeFetchError) return err.code
		throw err
	}
	return 'NO_ERROR'
}

describe('parseSafeUrl', () => {
	it('refuses anything but https on the standard port, and a login in the address', () => {
		expect(() => parseSafeUrl('http://example.com')).toThrow(SafeFetchError)
		expect(() => parseSafeUrl('https://example.com:8443/x')).toThrow('443')
		expect(() => parseSafeUrl('https://user:pw@example.com')).toThrow('login')
		expect(() => parseSafeUrl('not a url')).toThrow('valid web address')
		expect(parseSafeUrl('https://example.com:443/x').hostname).toBe('example.com')
	})
})

describe('resolvePublicAddress', () => {
	it('refuses localhost, 10/8 and the cloud metadata address given as literals', async () => {
		for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '[::ffff:7f00:1]']) {
			expect(await code(resolvePublicAddress(host, answer(PUBLIC)))).toBe('HOST_NOT_PUBLIC')
		}
	})

	it('refuses the name localhost when it resolves to a loopback address', async () => {
		expect(await code(resolvePublicAddress('localhost', answer('127.0.0.1', '::1')))).toBe(
			'HOST_NOT_PUBLIC',
		)
	})

	it('refuses a name that resolves to a private address, even next to a public one', async () => {
		expect(await code(resolvePublicAddress('evil.example.com', answer('10.1.2.3')))).toBe(
			'HOST_NOT_PUBLIC',
		)
		expect(await code(resolvePublicAddress('evil.example.com', answer(PUBLIC, '10.1.2.3')))).toBe(
			'HOST_NOT_PUBLIC',
		)
		expect(await code(resolvePublicAddress('evil.example.com', answer('64:ff9b::a9fe:a9fe')))).toBe(
			'HOST_NOT_PUBLIC',
		)
	})

	it('refuses a name that does not resolve', async () => {
		expect(await code(resolvePublicAddress('nope.example.com', answer()))).toBe('HOST_NOT_FOUND')
		expect(
			await code(
				resolvePublicAddress('nope.example.com', async () => {
					throw new Error('ENOTFOUND')
				}),
			),
		).toBe('HOST_NOT_FOUND')
	})

	it('returns the first address of a public name', async () => {
		expect(await resolvePublicAddress('example.com', answer(PUBLIC, '8.8.8.8'))).toBe(PUBLIC)
	})
})

describe('safeFetch', () => {
	let server: http.Server
	let port: number
	let bigBody: string
	let seen: { host?: string; auth?: string; url?: string; method?: string; body?: string }

	beforeAll(async () => {
		bigBody = 'x'.repeat(5_000)
		server = createServer((req, res) => {
			let body = ''
			req.on('data', (d) => {
				body += d
			})
			req.on('end', () => {
				seen = {
					host: req.headers.host,
					auth: req.headers.authorization,
					url: req.url,
					method: req.method,
					body,
				}
				if (req.url === '/redirect') {
					res.writeHead(302, { Location: 'http://127.0.0.1/secret' })
					res.end()
				} else if (req.url === '/big') {
					res.writeHead(200)
					res.end(bigBody)
				} else if (req.url === '/slow') {
					// never answers
				} else {
					res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': '7' })
					res.end(JSON.stringify({ ok: true }))
				}
			})
		})
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
		port = (server.address() as AddressInfo).port
	})
	afterAll(() => {
		server.closeAllConnections()
		server.close()
	})

	// A local http server stands in for the public site: the name resolves to a public address (so
	// the check passes) and the test seam dials the local server instead. node:http replaces
	// node:https, so the connection is not encrypted; everything else is the production path.
	const deps = () => ({
		resolve: answer(PUBLIC),
		dialAddress: '127.0.0.1',
		request: ((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
			http.request({ ...opts, port }, cb)) as never,
	})

	it('connects to the checked address and keeps the site name as the Host header', async () => {
		const res = await safeFetch(
			'https://shop.example.com/wp-json/wp/v2/posts?per_page=1',
			{ headers: { Authorization: 'Basic abc' } },
			deps(),
		)
		expect(res.status).toBe(200)
		expect(res.headers['x-wp-total']).toBe('7')
		expect(JSON.parse(res.body)).toEqual({ ok: true })
		expect(seen.host).toBe('shop.example.com')
		expect(seen.auth).toBe('Basic abc')
		expect(seen.url).toBe('/wp-json/wp/v2/posts?per_page=1')
	})

	it('looks the name up once and never dials a second answer', async () => {
		let lookups = 0
		const resolve = async () => {
			lookups++
			// A site that changes its answer: public the first time, internal after that.
			return lookups === 1 ? [PUBLIC] : ['169.254.169.254']
		}
		const res = await safeFetch('https://shop.example.com/', {}, { ...deps(), resolve })
		expect(res.status).toBe(200)
		expect(lookups).toBe(1)
	})

	it('refuses a redirect instead of following it', async () => {
		expect(await code(safeFetch('https://shop.example.com/redirect', {}, deps()))).toBe(
			'REDIRECT_REFUSED',
		)
	})

	it('stops reading an oversized reply', async () => {
		expect(
			await code(safeFetch('https://shop.example.com/big', { maxResponseBytes: 1_000 }, deps())),
		).toBe('RESPONSE_TOO_LARGE')
		const res = await safeFetch(
			'https://shop.example.com/big',
			{ maxResponseBytes: 10_000 },
			deps(),
		)
		expect(res.body).toHaveLength(5_000)
	})

	it('times out a site that never answers', async () => {
		expect(await code(safeFetch('https://shop.example.com/slow', { timeoutMs: 100 }, deps()))).toBe(
			'TIMEOUT',
		)
	})

	it('refuses an oversized request body before connecting', async () => {
		expect(
			await code(
				safeFetch(
					'https://shop.example.com/',
					{ method: 'POST', body: 'x'.repeat(SAFE_FETCH_MAX_REQUEST_BYTES + 1) },
					deps(),
				),
			),
		).toBe('REQUEST_TOO_LARGE')
	})

	it('refuses localhost, 10/8, the metadata address and a name that resolves privately', async () => {
		const never = {
			resolve: answer(PUBLIC),
			request: (() => {
				throw new Error('must not connect')
			}) as never,
		}
		for (const url of [
			'https://localhost/',
			'https://127.0.0.1/',
			'https://10.0.0.1/',
			'https://169.254.169.254/latest/meta-data/',
			'https://[::1]/',
			'https://[64:ff9b::a9fe:a9fe]/',
		]) {
			const resolve = url.includes('localhost') ? answer('127.0.0.1') : never.resolve
			expect(await code(safeFetch(url, {}, { ...never, resolve }))).toBe('HOST_NOT_PUBLIC')
		}
		expect(
			await code(
				safeFetch('https://internal.example.com/', {}, { ...never, resolve: answer('10.9.9.9') }),
			),
		).toBe('HOST_NOT_PUBLIC')
	})

	it('refuses http and other ports before any lookup', async () => {
		let asked = false
		const resolve = async () => {
			asked = true
			return [PUBLIC]
		}
		expect(await code(safeFetch('http://shop.example.com/', {}, { resolve }))).toBe('NOT_HTTPS')
		expect(await code(safeFetch('https://shop.example.com:8080/', {}, { resolve }))).toBe(
			'PORT_NOT_ALLOWED',
		)
		expect(asked).toBe(false)
	})
})
