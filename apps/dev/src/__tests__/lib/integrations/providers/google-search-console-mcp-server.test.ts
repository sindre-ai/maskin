import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
type RecordedEvent = { action: string; data?: { tool?: string } }
const recordEvent = vi.hoisted(() =>
	vi.fn(async (_db: unknown, _event: RecordedEvent): Promise<void> => undefined),
)
vi.mock('../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../lib/integrations/agent-access'
import {
	GSC_INSPECT_URL,
	GSC_SITES_URL,
	type GscMcpContext,
	createGscMcpServer,
} from '../../../../lib/integrations/providers/google-search-console/mcp-server'
import { gateMcpServer } from '../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const TOKEN = 'ya29.test-token'

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

async function connect(overrides: Partial<GscMcpContext> = {}, access?: AgentAccess) {
	const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
		jsonResponse(200, {}),
	)
	const getAccessToken = vi.fn(async () => TOKEN)
	const ctx: GscMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		integrationId: 'int-1',
		getAccessToken,
		fetchImpl: fetchImpl as unknown as typeof fetch,
		...overrides,
	}
	const server = createGscMcpServer(
		ctx,
		access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'google-search-console',
						providerLabel: 'Google Search Console',
						access,
					})
			: undefined,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, fetchImpl, getAccessToken }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}

describe('Search Console MCP server', () => {
	it('registers exactly the read and sitemap tools, classified as reads and writes', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual([
			'delete_sitemap',
			'get_sitemap',
			'inspect_url',
			'list_sitemaps',
			'list_sites',
			'submit_sitemap',
		])
		for (const read of ['inspect_url', 'list_sites', 'list_sitemaps', 'get_sitemap']) {
			expect(classifyTool('google-search-console', read)).toBe('read')
		}
		for (const write of ['submit_sitemap', 'delete_sitemap']) {
			expect(classifyTool('google-search-console', write)).toBe('write')
		}
		// Anything else on this provider is a write, so a read-only grant can never call it.
		expect(classifyTool('google-search-console', 'request_indexing')).toBe('write')
	})

	it('inspect_url posts inspectionUrl and siteUrl with the server-side token and returns the raw status', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		const google = {
			inspectionResult: {
				indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' },
			},
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, google))

		const result = await client.callTool({
			name: 'inspect_url',
			arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
		})

		expect(result.isError).toBeFalsy()
		expect(payload(result)).toEqual({ http_status: 200, body: google })
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(GSC_INSPECT_URL)
		expect(init?.method).toBe('POST')
		expect(JSON.parse(init?.body as string)).toEqual({
			inspectionUrl: 'https://maskin.io/',
			siteUrl: 'sc-domain:maskin.io',
		})
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		expect(getAccessToken).toHaveBeenCalledWith(expect.anything(), {
			workspaceId: 'ws-1',
			integrationId: 'int-1',
			actorId: 'agent-1',
			outboundTarget: 'searchconsole.googleapis.com',
		})
	})

	it("passes Google's error through with its status, and never echoes the token", async () => {
		const { client, fetchImpl } = await connect()
		const google = {
			error: {
				code: 403,
				status: 'PERMISSION_DENIED',
				details: [{ reason: 'SERVICE_DISABLED' }],
			},
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(403, google))

		const result = await client.callTool({
			name: 'inspect_url',
			arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
		})

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 403, body: google })
		expect(JSON.stringify(result)).not.toContain(TOKEN)
	})

	it('list_sites returns each site with its permission level', async () => {
		const { client, fetchImpl } = await connect()
		const google = {
			siteEntry: [{ siteUrl: 'sc-domain:maskin.io', permissionLevel: 'siteOwner' }],
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, google))

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(payload(result)).toEqual({ http_status: 200, body: google })
		expect(fetchImpl.mock.calls[0][0]).toBe(GSC_SITES_URL)
		expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET')
	})

	it('answers NOT_CONNECTED without calling Google when the workspace has no integration', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({ integrationId: null })

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('NOT_CONNECTED')
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('answers TOKEN_UNAVAILABLE without calling Google when the token cannot be read', async () => {
		const { client, fetchImpl } = await connect({
			getAccessToken: vi.fn(async () => {
				throw new Error('scope denied')
			}),
		})

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('TOKEN_UNAVAILABLE')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses an agent with no access before any token is read', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({}, 'none')

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(JSON.stringify(result.content)).toContain('needs read access to Google Search Console')
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('lets a read-only agent call the four read tools', async () => {
		const { client } = await connect({}, 'read')

		const calls = [
			{
				name: 'inspect_url',
				arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
			},
			{ name: 'list_sites', arguments: {} },
			{ name: 'list_sitemaps', arguments: { site_url: 'sc-domain:maskin.io' } },
			{
				name: 'get_sitemap',
				arguments: {
					site_url: 'sc-domain:maskin.io',
					sitemap_url: 'https://maskin.io/sitemap.xml',
				},
			},
		]
		for (const call of calls) {
			const result = await client.callTool(call)
			expect(result.isError, call.name).toBeFalsy()
		}
	})
})

const SITE = 'sc-domain:maskin.io'
const SITEMAP = 'https://maskin.io/sitemap.xml'
const SITE_API = 'https://www.googleapis.com/webmasters/v3/sites'
const SITE_PATH = `${SITE_API}/${encodeURIComponent(SITE)}`
const SITEMAP_PATH = `${SITE_PATH}/sitemaps/${encodeURIComponent(SITEMAP)}`

const sitemapStatus = { path: SITEMAP, lastSubmitted: '2026-10-25T10:00:00Z', isPending: true }

type Handler = (init?: RequestInit) => Response

/** Answers by "METHOD url"; a request nobody planned for fails the test. */
function stubGoogle(routes: Record<string, Handler>) {
	return async (url: string | URL | Request, init?: RequestInit) => {
		const key = `${init?.method ?? 'GET'} ${String(url)}`
		const handler = routes[key]
		if (!handler) throw new Error(`unplanned request: ${key}`)
		return handler(init)
	}
}

const owner = () => jsonResponse(200, { siteUrl: SITE, permissionLevel: 'siteOwner' })

function requests(fetchImpl: { mock: { calls: unknown[][] } }) {
	return fetchImpl.mock.calls.map(
		([url, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${String(url)}`,
	)
}

describe('Search Console sitemap reads', () => {
	it('list_sitemaps reads the property with the property percent-encoded in the path', async () => {
		const { client, fetchImpl } = await connect()
		const google = { sitemap: [sitemapStatus] }
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, google))

		const result = await client.callTool({ name: 'list_sitemaps', arguments: { site_url: SITE } })

		expect(payload(result)).toEqual({ http_status: 200, body: google })
		expect(requests(fetchImpl)).toEqual([`GET ${SITE_PATH}/sitemaps`])
	})

	it('get_sitemap encodes a sitemap URL that has a query string', async () => {
		const { client, fetchImpl } = await connect()
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, sitemapStatus))

		await client.callTool({
			name: 'get_sitemap',
			arguments: { site_url: SITE, sitemap_url: 'https://maskin.io/sitemap.xml?lang=en&x=1' },
		})

		expect(requests(fetchImpl)).toEqual([
			`GET ${SITE_PATH}/sitemaps/https%3A%2F%2Fmaskin.io%2Fsitemap.xml%3Flang%3Den%26x%3D1`,
		])
	})

	it('get_sitemap passes Googles 404 through', async () => {
		const { client, fetchImpl } = await connect()
		const google = { error: { code: 404, status: 'NOT_FOUND' } }
		fetchImpl.mockResolvedValueOnce(jsonResponse(404, google))

		const result = await client.callTool({
			name: 'get_sitemap',
			arguments: { site_url: SITE, sitemap_url: SITEMAP },
		})

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 404, body: google })
	})
})

describe('Search Console submit_sitemap', () => {
	beforeEach(() => recordEvent.mockClear())

	const submit = (client: Client, site_url = SITE, sitemap_url = SITEMAP) =>
		client.callTool({ name: 'submit_sitemap', arguments: { site_url, sitemap_url } })

	it('checks permission, submits, reads the status back and records the submit', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
				[`GET ${SITEMAP_PATH}`]: () => jsonResponse(200, sitemapStatus),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBeFalsy()
		expect(payload(result)).toEqual({ http_status: 204, submitted: true, sitemap: sitemapStatus })
		expect(requests(fetchImpl)).toEqual([
			`GET ${SITE_PATH}`,
			`PUT ${SITEMAP_PATH}`,
			`GET ${SITEMAP_PATH}`,
		])
		// One token read for the three requests.
		expect(getAccessToken).toHaveBeenCalledTimes(1)
		expect(recordEvent).toHaveBeenCalledTimes(1)
		expect(recordEvent).toHaveBeenCalledWith(expect.anything(), {
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			action: 'gsc_sitemap_submitted',
			entityType: 'integration',
			entityId: 'int-1',
			data: { provider: 'google-search-console', property: SITE, sitemap_url: SITEMAP },
		})
	})

	it('still reports the submit when the status read-back fails', async () => {
		const { client, fetchImpl } = await connect()
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
				[`GET ${SITEMAP_PATH}`]: () => jsonResponse(500, {}),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBeFalsy()
		expect(payload(result)).toEqual({
			http_status: 204,
			submitted: true,
			sitemap: null,
			status_read_failed: { http_status: 500 },
		})
	})

	it('reports a submit Google accepted even when the audit row cannot be written', async () => {
		const { client, fetchImpl } = await connect()
		recordEvent.mockRejectedValueOnce(new Error('db down'))
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
				[`GET ${SITEMAP_PATH}`]: () => jsonResponse(200, sitemapStatus),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBeFalsy()
		expect(payload(result).submitted).toBe(true)
		expect(payload(result).warning).toContain('could not record it')
	})

	it('encodes a domain property and a sitemap URL with a query string in the path', async () => {
		const { client, fetchImpl } = await connect()
		const sitemap = 'https://blog.maskin.io/sitemap.xml?lang=en&x=1'
		const path = `${SITE_PATH}/sitemaps/${encodeURIComponent(sitemap)}`
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${path}`]: () => new Response(null, { status: 204 }),
				[`GET ${path}`]: () => jsonResponse(200, sitemapStatus),
			}),
		)

		const result = await submit(client, SITE, sitemap)

		expect(result.isError).toBeFalsy()
		expect(path).toContain('sc-domain%3Amaskin.io/sitemaps/https%3A%2F%2Fblog.maskin.io')
		expect(recordEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ data: expect.objectContaining({ sitemap_url: sitemap }) }),
		)
	})

	it.each([
		['a different domain', SITE, 'https://example.com/sitemap.xml'],
		['a domain that only ends the same way', SITE, 'https://notmaskin.io/sitemap.xml'],
		['the domain as a prefix of another host', SITE, 'https://maskin.io.evil.test/sitemap.xml'],
		['a URL with the domain in the user part', SITE, 'https://maskin.io@evil.test/sitemap.xml'],
		['a relative path', SITE, '/sitemap.xml'],
		['a non-http scheme', SITE, 'ftp://maskin.io/sitemap.xml'],
		['outside a URL-prefix property', 'https://maskin.io/blog/', 'https://maskin.io/sitemap.xml'],
		[
			'another protocol than a URL-prefix property',
			'https://maskin.io/',
			'http://maskin.io/sitemap.xml',
		],
		['a property that is neither form', 'maskin.io', SITEMAP],
	])('refuses %s before calling Google', async (_label, site, sitemap) => {
		const { client, fetchImpl, getAccessToken } = await connect()

		const result = await submit(client, site, sitemap)

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('INVALID_SITEMAP_URL')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it.each([
		['a subdomain of a domain property', SITE, 'https://www.maskin.io/sitemap.xml'],
		[
			'a path under a URL-prefix property',
			'https://maskin.io/blog/',
			'https://maskin.io/blog/sitemap.xml',
		],
	])('accepts %s', async (_label, site, sitemap) => {
		const { client, fetchImpl } = await connect()
		const sitePath = `${SITE_API}/${encodeURIComponent(site)}`
		const path = `${sitePath}/sitemaps/${encodeURIComponent(sitemap)}`
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${sitePath}`]: owner,
				[`PUT ${path}`]: () => new Response(null, { status: 204 }),
				[`GET ${path}`]: () => jsonResponse(200, sitemapStatus),
			}),
		)

		const result = await submit(client, site, sitemap)

		expect(payload(result).submitted).toBe(true)
	})

	it('refuses a restricted user without trying the submit', async () => {
		const { client, fetchImpl } = await connect()
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: () => jsonResponse(200, { permissionLevel: 'siteRestrictedUser' }),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('PROPERTY_NOT_WRITABLE')
		expect(requests(fetchImpl)).toEqual([`GET ${SITE_PATH}`])
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('passes Googles answer through when the account does not have the property', async () => {
		const { client, fetchImpl } = await connect()
		const google = { error: { code: 403, status: 'PERMISSION_DENIED' } }
		fetchImpl.mockImplementation(
			stubGoogle({ [`GET ${SITE_PATH}`]: () => jsonResponse(403, google) }),
		)

		const result = await submit(client)

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 403, body: google })
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('tells the agent to ask for a reconnect when the token only has the read-only scope', async () => {
		const { client, fetchImpl } = await connect()
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () =>
					jsonResponse(403, {
						error: {
							code: 403,
							message: 'Request had insufficient authentication scopes.',
							details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
						},
					}),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('RECONNECT_REQUIRED')
		expect(payload(result).error.message).toContain('reconnect')
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('passes any other refusal through and records nothing', async () => {
		const { client, fetchImpl } = await connect()
		const google = {
			error: { code: 403, message: 'User does not have sufficient permission for site.' },
		}
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () => jsonResponse(403, google),
			}),
		)

		const result = await submit(client)

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 403, body: google })
		expect(recordEvent).not.toHaveBeenCalled()
	})
})

describe('Search Console delete_sitemap', () => {
	beforeEach(() => recordEvent.mockClear())

	const remove = (client: Client, site_url = SITE, sitemap_url = SITEMAP) =>
		client.callTool({ name: 'delete_sitemap', arguments: { site_url, sitemap_url } })

	const lastAction = (action: 'gsc_sitemap_submitted' | 'gsc_sitemap_deleted' | null) =>
		vi.fn(async () => action)

	it('deletes a sitemap Maskin submitted and records the delete', async () => {
		const findLastSitemapAction = lastAction('gsc_sitemap_submitted')
		const { client, fetchImpl } = await connect({ findLastSitemapAction })
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`DELETE ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
			}),
		)

		const result = await remove(client)

		expect(result.isError).toBeFalsy()
		expect(payload(result)).toEqual({ http_status: 204, deleted: true })
		// Keyed by workspace, property and URL. No connection id, so it survives a reconnect.
		expect(findLastSitemapAction).toHaveBeenCalledWith(expect.anything(), {
			workspaceId: 'ws-1',
			property: SITE,
			sitemapUrl: SITEMAP,
		})
		expect(recordEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: 'gsc_sitemap_deleted',
				data: { provider: 'google-search-console', property: SITE, sitemap_url: SITEMAP },
			}),
		)
	})

	it('looks the submit up by property and URL when the connection is a new one', async () => {
		// Same workspace, new connection id: what a reconnect produces.
		const findLastSitemapAction = lastAction('gsc_sitemap_submitted')
		const { client, fetchImpl } = await connect({ integrationId: 'int-2', findLastSitemapAction })
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`DELETE ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
			}),
		)

		const result = await remove(client)

		expect(payload(result).deleted).toBe(true)
		expect(JSON.stringify(findLastSitemapAction.mock.calls)).not.toContain('int-')
	})

	it.each([
		['one added in Search Console (no record)', null],
		['one Maskin already deleted', 'gsc_sitemap_deleted' as const],
	])('refuses %s without calling Google', async (_label, last) => {
		const { client, fetchImpl, getAccessToken } = await connect({
			findLastSitemapAction: lastAction(last),
		})

		const result = await remove(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('NOT_SUBMITTED_BY_MASKIN')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('refuses a sitemap outside the property before looking anything up', async () => {
		const findLastSitemapAction = lastAction('gsc_sitemap_submitted')
		const { client, fetchImpl } = await connect({ findLastSitemapAction })

		const result = await remove(client, SITE, 'https://notmaskin.io/sitemap.xml')

		expect(payload(result).error.code).toBe('INVALID_SITEMAP_URL')
		expect(findLastSitemapAction).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('passes Googles 404 through and records nothing', async () => {
		const { client, fetchImpl } = await connect({
			findLastSitemapAction: lastAction('gsc_sitemap_submitted'),
		})
		const google = { error: { code: 404, status: 'NOT_FOUND' } }
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`DELETE ${SITEMAP_PATH}`]: () => jsonResponse(404, google),
			}),
		)

		const result = await remove(client)

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 404, body: google })
		expect(recordEvent).not.toHaveBeenCalled()
	})
})

describe('Search Console sitemap tools and agent access', () => {
	beforeEach(() => recordEvent.mockClear())

	const writes = [
		{ name: 'submit_sitemap', arguments: { site_url: SITE, sitemap_url: SITEMAP } },
		{ name: 'delete_sitemap', arguments: { site_url: SITE, sitemap_url: SITEMAP } },
	]

	it.each(['read', 'none'] as const)(
		'refuses both write tools for an agent with %s access, without reaching Google',
		async (access) => {
			const { client, fetchImpl, getAccessToken } = await connect(
				{ findLastSitemapAction: vi.fn(async () => 'gsc_sitemap_submitted' as const) },
				access,
			)

			for (const call of writes) {
				const result = await client.callTool(call)
				expect(result.isError, call.name).toBe(true)
				expect(JSON.stringify(result.content)).toContain(
					'needs write access to Google Search Console',
				)
			}

			expect(fetchImpl).not.toHaveBeenCalled()
			expect(getAccessToken).not.toHaveBeenCalled()
			const denials = recordEvent.mock.calls.filter(([, e]) => e.action === 'agent_access_denied')
			expect(denials.map(([, e]) => e.data?.tool)).toEqual(['submit_sitemap', 'delete_sitemap'])
			expect(
				recordEvent.mock.calls.some(([, e]) => String(e.action).startsWith('gsc_sitemap')),
			).toBe(false)
		},
	)

	it('lets an agent with read and write access submit', async () => {
		const { client, fetchImpl } = await connect({}, 'read_write')
		fetchImpl.mockImplementation(
			stubGoogle({
				[`GET ${SITE_PATH}`]: owner,
				[`PUT ${SITEMAP_PATH}`]: () => new Response(null, { status: 204 }),
				[`GET ${SITEMAP_PATH}`]: () => jsonResponse(200, sitemapStatus),
			}),
		)

		const result = await client.callTool(writes[0])

		expect(payload(result).submitted).toBe(true)
	})

	it('lists the write tools as unavailable to a read-only agent', async () => {
		const { client } = await connect({}, 'read')
		const { tools } = await client.listTools()
		const byName = new Map(tools.map((t) => [t.name, t]))

		expect(byName.get('submit_sitemap')?.description).toContain('[Unavailable: needs write access')
		expect(byName.get('delete_sitemap')?.description).toContain('[Unavailable: needs write access')
		expect(byName.get('list_sitemaps')?.description).not.toContain('[Unavailable')
	})
})
