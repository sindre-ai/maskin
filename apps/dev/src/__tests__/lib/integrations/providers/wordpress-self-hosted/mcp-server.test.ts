import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const recordEvent = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined))
vi.mock('../../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../../lib/integrations/agent-access'
import type { WordPressCredentials } from '../../../../../lib/integrations/providers/wordpress-self-hosted/credentials'
import {
	type WordPressMcpContext,
	createWordPressMcpServer,
} from '../../../../../lib/integrations/providers/wordpress-self-hosted/mcp-server'
import type { SafeFetchInit, SafeFetchResult } from '../../../../../lib/integrations/safe-fetch'
import { gateMcpServer } from '../../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../../lib/integrations/tool-kinds'

const PASSWORD = 'abcdEFGHijklMNOP'
const creds: WordPressCredentials = {
	site_url: 'https://example.com',
	username: 'editor',
	application_password: PASSWORD,
	rest_style: 'pretty',
}

type Call = { url: string; init: SafeFetchInit }

/** A stand-in for the site: drafts 11 and 12 and a live post 20. Records every call it gets. */
function fakeSite() {
	const calls: Call[] = []
	const items: Record<string, { id: number; status: string }> = {
		'11': { id: 11, status: 'draft' },
		'12': { id: 12, status: 'pending' },
		'20': { id: 20, status: 'publish' },
	}
	const fetchImpl = vi.fn(
		async (url: string, init: SafeFetchInit = {}): Promise<SafeFetchResult> => {
			calls.push({ url, init })
			const json = (status: number, body: unknown) => ({
				status,
				headers: { 'x-wp-total': '2', 'x-wp-totalpages': '1' },
				body: JSON.stringify(body),
			})
			const path = new URL(url).pathname
			const id = path.match(/\/(posts|pages)\/(\d+)$/)?.[2]
			if (path.endsWith('/users/me')) {
				return json(200, { id: 4, name: 'Ed', capabilities: { edit_posts: true } })
			}
			if (url.endsWith('/wp-json/')) {
				return json(200, {
					name: 'Shop',
					namespaces: ['wp/v2'],
					authentication: { 'application-passwords': {} },
				})
			}
			if (init.method === 'POST' && !id) {
				const body = JSON.parse(init.body ?? '{}')
				// What a real site does with a status it is sent.
				return json(201, {
					id: 99,
					status: body.status ?? 'draft',
					title: { rendered: body.title },
				})
			}
			if (init.method === 'POST' && id) {
				const body = JSON.parse(init.body ?? '{}')
				return json(200, {
					id: Number(id),
					status: items[id]?.status,
					title: { rendered: body.title ?? 'T' },
				})
			}
			if (id) {
				const found = items[id]
				if (!found) return json(404, { code: 'rest_post_invalid_id' })
				return json(200, {
					...found,
					title: { rendered: 'Hello &amp; welcome' },
					content: {
						raw: '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
						rendered: '<p>Hi</p>',
					},
					excerpt: { rendered: '<p>Short</p>' },
				})
			}
			if (path.endsWith('/media')) {
				return json(200, [
					{
						id: 5,
						title: { rendered: 'Logo' },
						media_type: 'image',
						source_url: 'https://example.com/a.png',
					},
				])
			}
			return json(200, [
				{
					id: 11,
					status: 'draft',
					title: { rendered: 'One' },
					excerpt: { rendered: '<p>Hello <b>there</b></p>' },
				},
			])
		},
	)
	return { fetchImpl, calls }
}

async function connect(access?: AgentAccess, overrides: Partial<WordPressMcpContext> = {}) {
	const site = fakeSite()
	const getCredentials = vi.fn(async () => creds)
	const trackToolCalled = vi.fn(async () => undefined)
	const ctx: WordPressMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		sessionId: 'sess-1',
		integrationId: 'int-1',
		siteLabel: 'example.com',
		getCredentials,
		fetchImpl: site.fetchImpl,
		trackToolCalled,
		...overrides,
	}
	const server = createWordPressMcpServer(
		ctx,
		access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'wordpress-self-hosted',
						providerLabel: 'WordPress',
						access,
					})
			: undefined,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, ...site, getCredentials, trackToolCalled }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}

const READ_TOOLS = [
	'wordpress_check_connection',
	'wordpress_get_media',
	'wordpress_get_page',
	'wordpress_get_post',
	'wordpress_list_media',
	'wordpress_list_pages',
	'wordpress_list_posts',
]
const WRITE_TOOLS = [
	'wordpress_create_page',
	'wordpress_create_post',
	'wordpress_update_page',
	'wordpress_update_post',
]

describe('WordPress MCP server', () => {
	it('registers the read tools and the four write tools, each classified correctly', async () => {
		const { client } = await connect()
		const names = (await client.listTools()).tools.map((t) => t.name).sort()
		expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort())
		for (const n of READ_TOOLS) expect(classifyTool('wordpress-self-hosted', n)).toBe('read')
		for (const n of WRITE_TOOLS) expect(classifyTool('wordpress-self-hosted', n)).toBe('write')
	})

	it('has no delete, upload or publish tool, and the create and edit tools take no status', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).join(' ')).not.toMatch(/delete|upload|publish/)
		for (const t of tools.filter((x) => /_(create|update)_/.test(x.name))) {
			expect(
				Object.keys((t.inputSchema as { properties?: object }).properties ?? {}),
			).not.toContain('status')
		}
	})

	describe('access: Read versus Read and write, enforced per tool', () => {
		it('a Read agent can read and is refused every write, and the site is never called for a write', async () => {
			const { client, calls } = await connect('read')
			const list = await client.callTool({ name: 'wordpress_list_posts', arguments: {} })
			expect(list.isError).toBeFalsy()
			const before = calls.length
			for (const name of WRITE_TOOLS) {
				const res = await client.callTool({ name, arguments: { id: 11, title: 'x', content: 'y' } })
				expect(res.isError).toBe(true)
				expect((res.content as Array<{ text: string }>)[0]?.text).toContain('Access denied')
			}
			expect(calls.length).toBe(before)
		})

		it('a Read and write agent can create and edit', async () => {
			const { client } = await connect('read_write')
			const res = await client.callTool({
				name: 'wordpress_create_post',
				arguments: { title: 'New' },
			})
			expect(res.isError).toBeFalsy()
		})

		it('an agent with no access is refused reads too, and the login is never read', async () => {
			const { client, getCredentials } = await connect('none')
			const res = await client.callTool({ name: 'wordpress_list_posts', arguments: {} })
			expect(res.isError).toBe(true)
			expect(getCredentials).not.toHaveBeenCalled()
		})
	})

	describe('new posts and pages are drafts', () => {
		it.each([
			['wordpress_create_post', '/wp-json/wp/v2/posts'],
			['wordpress_create_page', '/wp-json/wp/v2/pages'],
		])('%s always sends status draft, whatever it is given', async (name, path) => {
			const { client, calls } = await connect('read_write')
			// A status the schema does not know is not passed through.
			const res = await client.callTool({
				name,
				arguments: { title: 'Launch', content: '<p>Hi</p>', status: 'publish' },
			})
			const post = calls.find((c) => c.init.method === 'POST')
			expect(new URL(post?.url ?? '').pathname).toBe(path)
			const sent = JSON.parse(post?.init.body ?? '{}')
			expect(sent).toEqual({ status: 'draft', title: 'Launch', content: '<p>Hi</p>' })
			expect(payload(res)).toMatchObject({ id: 99, status: 'draft' })
			expect(payload(res).edit_url).toBe(
				'https://example.com/wp-admin/post.php?post=99&action=edit',
			)
		})
	})

	describe('editing never sets a status and never touches live items', () => {
		it('edits a draft without sending any status', async () => {
			const { client, calls } = await connect('read_write')
			const res = await client.callTool({
				name: 'wordpress_update_post',
				arguments: { id: 11, content: 'New text', status: 'publish' },
			})
			expect(res.isError).toBeFalsy()
			const post = calls.find((c) => c.init.method === 'POST')
			expect(JSON.parse(post?.init.body ?? '{}')).toEqual({ content: 'New text' })
		})

		it('refuses a published post and sends no write to the site', async () => {
			const { client, calls } = await connect('read_write')
			const res = await client.callTool({
				name: 'wordpress_update_post',
				arguments: { id: 20, content: 'Changed' },
			})
			expect(res.isError).toBe(true)
			expect(payload(res).error.code).toBe('NOT_ALLOWED')
			expect(calls.some((c) => c.init.method === 'POST')).toBe(false)
		})

		it('refuses an edit with nothing to change', async () => {
			const { client, calls } = await connect('read_write')
			const res = await client.callTool({ name: 'wordpress_update_page', arguments: { id: 11 } })
			expect(payload(res).error.code).toBe('INVALID_INPUT')
			expect(calls).toHaveLength(0)
		})
	})

	describe('reads', () => {
		it('lists posts with a plain-text excerpt and the site totals', async () => {
			const { client, calls } = await connect('read')
			const res = payload(
				await client.callTool({ name: 'wordpress_list_posts', arguments: { per_page: 5 } }),
			)
			expect(res.items[0]).toMatchObject({ id: 11, title: 'One', excerpt: 'Hello there' })
			expect(res).toMatchObject({ total: 2, total_pages: 1 })
			expect(calls[0]?.url).toContain('per_page=5')
		})

		it('gets one post with the editor text', async () => {
			const { client } = await connect('read')
			const res = payload(
				await client.callTool({ name: 'wordpress_get_post', arguments: { id: 11 } }),
			)
			expect(res).toMatchObject({ id: 11, title: 'Hello & welcome', content_is_block_markup: true })
			expect(res.content).toContain('wp:paragraph')
		})

		it('lists media', async () => {
			const { client } = await connect('read')
			const res = payload(await client.callTool({ name: 'wordpress_list_media', arguments: {} }))
			expect(res.items[0]).toMatchObject({ id: 5, title: 'Logo', media_type: 'image' })
		})

		it('checks the connection', async () => {
			const { client } = await connect('read')
			const res = payload(
				await client.callTool({ name: 'wordpress_check_connection', arguments: {} }),
			)
			expect(res).toMatchObject({
				site: 'https://example.com',
				signed_in_as: 'Ed',
				can_edit_posts: true,
			})
		})

		it('says not found for an id the site does not have', async () => {
			const { client } = await connect('read')
			const res = await client.callTool({ name: 'wordpress_get_post', arguments: { id: 404 } })
			expect(payload(res).error.code).toBe('NOT_FOUND')
		})
	})

	describe('secrets and events', () => {
		it('never returns the password, and the analytics event carries no arguments or text', async () => {
			const { client, trackToolCalled } = await connect('read_write')
			const res = await client.callTool({ name: 'wordpress_get_post', arguments: { id: 11 } })
			expect(JSON.stringify(res)).not.toContain(PASSWORD)
			expect(JSON.stringify(res)).not.toContain('editor:')
			expect(trackToolCalled).toHaveBeenCalledWith({
				provider: 'wordpress-self-hosted',
				tool: 'wordpress_get_post',
				outcome: 'success',
				errorCode: null,
				actorId: 'agent-1',
				sessionId: 'sess-1',
				workspaceId: 'ws-1',
			})
		})

		it('answers NOT_CONNECTED when the workspace has no site', async () => {
			const { client } = await connect('read', { integrationId: null })
			const res = await client.callTool({ name: 'wordpress_list_posts', arguments: {} })
			expect(payload(res).error.code).toBe('NOT_CONNECTED')
		})

		it('answers without detail when the login cannot be read', async () => {
			const { client } = await connect('read', {
				getCredentials: async () => {
					throw new Error(`boom ${PASSWORD}`)
				},
			})
			const res = await client.callTool({ name: 'wordpress_list_posts', arguments: {} })
			expect(payload(res).error.code).toBe('CREDENTIAL_UNAVAILABLE')
			expect(JSON.stringify(res)).not.toContain(PASSWORD)
		})
	})
})
