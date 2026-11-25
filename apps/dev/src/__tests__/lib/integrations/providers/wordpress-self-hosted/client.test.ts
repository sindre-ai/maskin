import { describe, expect, it, vi } from 'vitest'
import {
	WordPressError,
	discoverSite,
	restUrl,
	whoAmI,
	wpCall,
} from '../../../../../lib/integrations/providers/wordpress-self-hosted/client'
import type { WordPressCredentials } from '../../../../../lib/integrations/providers/wordpress-self-hosted/credentials'
import { SafeFetchError } from '../../../../../lib/integrations/safe-fetch'
import type { SafeFetchResult } from '../../../../../lib/integrations/safe-fetch'

const creds: WordPressCredentials = {
	site_url: 'https://example.com',
	username: 'editor',
	application_password: 'secretsecret',
	rest_style: 'pretty',
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	({
		status,
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body),
	}) satisfies SafeFetchResult

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p
	} catch (err) {
		if (err instanceof WordPressError) return err.code
		throw err
	}
	return 'NO_ERROR'
}

describe('restUrl', () => {
	it('builds pretty and plain-permalink addresses', () => {
		expect(restUrl(creds, 'wp/v2/posts', { per_page: 5, search: undefined })).toBe(
			'https://example.com/wp-json/wp/v2/posts?per_page=5',
		)
		expect(restUrl({ ...creds, rest_style: 'query' }, 'wp/v2/posts', { per_page: 5 })).toBe(
			'https://example.com/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=5',
		)
	})
})

describe('wpCall', () => {
	it('sends basic auth and returns the body and the site totals', async () => {
		const fetchImpl = vi.fn(async () =>
			reply(200, [{ id: 1 }], { 'x-wp-total': '9', 'x-wp-totalpages': '2' }),
		)
		const res = await wpCall(creds, 'wp/v2/posts', {}, fetchImpl)
		const [, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			{ headers: Record<string, string> },
		]
		expect(init.headers.Authorization).toBe(
			`Basic ${Buffer.from('editor:secretsecret').toString('base64')}`,
		)
		expect(res).toMatchObject({ json: [{ id: 1 }], total: 9, totalPages: 2 })
	})

	it('maps the answers a person can act on', async () => {
		const cases: Array<[SafeFetchResult, string]> = [
			[reply(401, { code: 'incorrect_password' }), 'BAD_LOGIN'],
			[reply(401, { code: 'rest_not_logged_in' }), 'BAD_LOGIN'],
			[reply(403, { code: 'rest_forbidden' }), 'NOT_ALLOWED'],
			[reply(403, '<html>blocked by firewall</html>'), 'REST_BLOCKED'],
			[reply(404, { code: 'rest_post_invalid_id' }), 'NOT_FOUND'],
			[reply(404, '<html>not found</html>'), 'NOT_WORDPRESS'],
			[reply(429, {}), 'RATE_LIMITED'],
			[reply(503, 'down'), 'SITE_ERROR'],
			[reply(200, '<html>login page</html>'), 'UNEXPECTED_RESPONSE'],
		]
		for (const [answer, code] of cases) {
			expect(await codeOf(wpCall(creds, 'wp/v2/posts', {}, async () => answer))).toBe(code)
		}
	})

	it('never puts the site body or the password in an error', async () => {
		try {
			await wpCall(creds, 'wp/v2/posts', {}, async () =>
				reply(401, { message: 'secretsecret leaked' }),
			)
		} catch (err) {
			expect(String((err as Error).message)).not.toContain('secretsecret')
		}
	})

	it('turns a transport failure into a message, not a stack', async () => {
		const blocked = async () => {
			throw new SafeFetchError('HOST_NOT_PUBLIC', 'That address is not reachable from here.')
		}
		expect(await codeOf(wpCall(creds, 'wp/v2/posts', {}, blocked))).toBe('NOT_PUBLIC')
		const redirect = async () => {
			throw new SafeFetchError('REDIRECT_REFUSED', 'x')
		}
		expect(await codeOf(wpCall(creds, 'wp/v2/posts', {}, redirect))).toBe('REQUEST_REFUSED')
	})
})

describe('discoverSite', () => {
	const index = {
		name: 'Shop',
		namespaces: ['wp/v2'],
		authentication: { 'application-passwords': {} },
	}

	it('finds pretty links and reads whether application passwords are offered', async () => {
		const info = await discoverSite('https://example.com', async () => reply(200, index))
		expect(info).toEqual({ rest_style: 'pretty', name: 'Shop', application_passwords: true })
	})

	it('falls back to the plain form, and reports application passwords as off', async () => {
		const calls: string[] = []
		const info = await discoverSite('https://example.com', async (url) => {
			calls.push(url)
			return url.includes('/wp-json/')
				? reply(404, 'nope')
				: reply(200, { ...index, authentication: [] })
		})
		expect(info.rest_style).toBe('query')
		expect(info.application_passwords).toBe(false)
		expect(calls[1]).toBe('https://example.com/?rest_route=/')
	})

	it('says the REST address is blocked when both forms answer 401 or 403', async () => {
		expect(await codeOf(discoverSite('https://example.com', async () => reply(403, 'no')))).toBe(
			'REST_BLOCKED',
		)
	})

	it('says it is not WordPress when nothing answers like it', async () => {
		expect(
			await codeOf(discoverSite('https://example.com', async () => reply(200, '<html>'))),
		).toBe('NOT_WORDPRESS')
	})

	it('reports a refused host as not public, without a second try', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new SafeFetchError('HOST_NOT_PUBLIC', 'x')
		})
		expect(await codeOf(discoverSite('https://example.com', fetchImpl))).toBe('NOT_PUBLIC')
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})

describe('whoAmI', () => {
	it('returns the user and whether they can edit posts', async () => {
		const me = await whoAmI(creds, async () =>
			reply(200, { id: 4, name: 'Ed', capabilities: { edit_posts: true } }),
		)
		expect(me).toEqual({ id: 4, name: 'Ed', can_edit_posts: true })
	})
})
