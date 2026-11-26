import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations, workspaceMembers } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')

/**
 * Search, read and archive or label through the normal Gmail API. Gmail is stubbed at `fetch`
 * (by URL, because the routes call it in parallel): this proves our rules (who may read, who may
 * change labels, which account is used, what is refused), not that Gmail behaves as assumed.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

const LABELS = {
	labels: [
		{ id: 'INBOX', name: 'INBOX', type: 'system' },
		{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
		{ id: 'TRASH', name: 'TRASH', type: 'system' },
		{ id: 'Label_7', name: 'Receipts', type: 'user' },
	],
}

const THREAD_FULL = {
	id: 'thr1',
	messages: [
		{
			id: 'msg1',
			labelIds: ['INBOX', 'UNREAD', 'Label_7'],
			internalDate: '1764000000000',
			payload: {
				mimeType: 'multipart/mixed',
				headers: [
					{ name: 'From', value: 'Mette Holm <mette@northwind.dk>' },
					{ name: 'To', value: 'sender@example.com' },
					{ name: 'Subject', value: 'Invoice 4711' },
				],
				parts: [
					{
						mimeType: 'multipart/alternative',
						parts: [
							{
								partId: '0.0',
								mimeType: 'text/plain',
								body: { data: b64('Hello, see attached.') },
							},
							{ partId: '0.1', mimeType: 'text/html', body: { data: b64('<p>Hello HTML</p>') } },
						],
					},
					{
						partId: '1',
						mimeType: 'application/pdf',
						filename: 'invoice 4711.pdf',
						body: { attachmentId: 'ATT-1', size: 1234 },
					},
				],
			},
		},
	],
}

const THREAD_META = {
	id: 'thr1',
	messages: [
		{
			id: 'msg1',
			labelIds: ['INBOX', 'UNREAD'],
			snippet: 'Hello, see attached.',
			internalDate: '1764000000000',
			payload: {
				headers: [
					{ name: 'From', value: 'Mette Holm <mette@northwind.dk>' },
					{ name: 'Subject', value: 'Invoice 4711' },
				],
			},
		},
	],
}

/** Answers Gmail by path and records every call as "METHOD path" with its token. */
function stubGmail() {
	const calls: Array<{ method: string; url: string; token: string; body?: unknown }> = []
	fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const headers = (init?.headers ?? {}) as Record<string, string>
		calls.push({
			method,
			url,
			token: headers.Authorization ?? '',
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		})
		const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '')
		if (path.startsWith('/labels')) return json(200, LABELS)
		if (path.startsWith('/threads/thr1/modify')) {
			return json(200, { id: 'thr1', messages: [{ labelIds: ['UNREAD', 'Label_7'] }] })
		}
		if (path.startsWith('/threads/thr1?format=full')) return json(200, THREAD_FULL)
		if (path.startsWith('/threads/thr1?')) return json(200, THREAD_META)
		if (path.startsWith('/threads?')) return json(200, { threads: [{ id: 'thr1' }] })
		return json(404, { error: { message: 'Not Found' } })
	})
	return calls
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.route('/api/integrations/gmail', gmailRoutes as never)
	return app
}

type Access = 'read' | 'read_write' | null

async function insertGmail(
	workspaceId: string,
	agentId: string,
	externalId: string,
	token: string,
	access: Access,
	createdAt?: Date,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'gmail',
			status: 'active',
			externalId,
			credentials: encrypt(
				JSON.stringify({ accessToken: token, expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: getTestActorId(),
			defaultAgentAccess: 'none' as const,
			...(createdAt ? { createdAt } : {}),
		})
		.returning()
	if (!row) throw new Error('gmail integration was not inserted')
	if (access) {
		await insertAgentGrant(db, { workspaceId, integrationId: row.id, actorId: agentId, access })
	}
}

async function setup(accounts: Array<{ address: string; token: string; access: Access }>) {
	const workspace = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	let day = 1
	for (const a of accounts) {
		await insertGmail(
			workspace.id,
			agent.id,
			a.address,
			a.token,
			a.access,
			new Date(`2026-01-${String(day++).padStart(2, '0')}`),
		)
	}
	const headers = { 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id }
	const app = appFor(agent.id)
	return {
		search: (query = '') => app.request(`/api/integrations/gmail/search${query}`, { headers }),
		thread: (query: string) => app.request(`/api/integrations/gmail/thread${query}`, { headers }),
		labels: (body: Record<string, unknown>) =>
			app.request('/api/integrations/gmail/thread-labels', {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}),
	}
}

const one = (access: Access) => [{ address: 'sender@example.com', token: 'tok-1', access }]

describe('GET /api/integrations/gmail/search', () => {
	it('lets a read agent search and lists subject, sender, labels and unread', async () => {
		const calls = stubGmail()
		const { search } = await setup(one('read'))

		const res = await search('?q=from%3Amette%20is%3Aunread&max_results=5')

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			threads: Array<Record<string, unknown>>
			next_page_token: string | null
		}
		expect(body.threads).toEqual([
			{
				thread_id: 'thr1',
				subject: 'Invoice 4711',
				from: 'Mette Holm <mette@northwind.dk>',
				date: '2025-11-24T16:00:00.000Z',
				snippet: 'Hello, see attached.',
				message_count: 1,
				labels: ['Inbox', 'Unread'],
				unread: true,
			},
		])
		const list = calls.find((c) => c.url.includes('/threads?'))
		expect(list?.url).toContain('q=from%3Amette+is%3Aunread')
		expect(list?.url).toContain('maxResults=5')
		expect(calls.every((c) => c.method === 'GET')).toBe(true)
	})

	it('refuses an agent with no Gmail access and asks Gmail nothing', async () => {
		const calls = stubGmail()
		const { search } = await setup(one(null))

		const res = await search()

		expect(res.status).toBe(403)
		expect(calls).toHaveLength(0)
	})

	it('refuses a page token that could change the Gmail URL', async () => {
		const calls = stubGmail()
		const { search } = await setup(one('read'))

		const res = await search('?page_token=x%26labelIds%3DTRASH')

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

describe('GET /api/integrations/gmail/thread', () => {
	it('returns every message with sender, body text, labels and attachments', async () => {
		const calls = stubGmail()
		const { thread } = await setup(one('read'))

		const res = await thread('?thread_id=thr1')

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			subject: string
			labels: string[]
			messages: Array<Record<string, unknown>>
		}
		expect(body.subject).toBe('Invoice 4711')
		expect(body.labels).toEqual(['Inbox', 'Unread', 'Receipts'])
		expect(body.messages[0]).toMatchObject({
			message_id: 'msg1',
			from: 'Mette Holm <mette@northwind.dk>',
			to: 'sender@example.com',
			// The plain part wins over the HTML part.
			body: 'Hello, see attached.',
			body_truncated: false,
			attachments: [
				{
					name: 'invoice 4711.pdf',
					mime_type: 'application/pdf',
					size_bytes: 1234,
					part_id: '1',
					attachment_id: 'ATT-1',
				},
			],
		})
		expect(calls.every((c) => c.method === 'GET')).toBe(true)
	})

	it('answers 404 for a thread Gmail does not have', async () => {
		stubGmail()
		const { thread } = await setup(one('read'))

		const res = await thread('?thread_id=nope')

		expect(res.status).toBe(404)
	})

	it('refuses a thread id that could change the Gmail URL', async () => {
		const calls = stubGmail()
		const { thread } = await setup(one('read'))

		const res = await thread('?thread_id=thr1%2Fmodify')

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

describe('POST /api/integrations/gmail/thread-labels', () => {
	it('archives a thread for a read and write agent by removing it from the inbox', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read_write'))

		const res = await labels({ thread_id: 'thr1', archive: true })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			thread_id: 'thr1',
			archived: true,
			removed: ['Inbox'],
		})
		const modify = calls.find((c) => c.url.includes('/modify'))
		expect(modify?.method).toBe('POST')
		expect(modify?.body).toEqual({ addLabelIds: [], removeLabelIds: ['INBOX'] })
	})

	it('adds a label by name, matched without regard to case, and marks read', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read_write'))

		const res = await labels({
			thread_id: 'thr1',
			add_labels: ['receipts'],
			remove_labels: ['UNREAD'],
		})

		expect(res.status).toBe(200)
		const modify = calls.find((c) => c.url.includes('/modify'))
		expect(modify?.body).toEqual({ addLabelIds: ['Label_7'], removeLabelIds: ['UNREAD'] })
	})

	it('refuses a read-only agent and changes nothing', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read'))

		const res = await labels({ thread_id: 'thr1', archive: true })

		expect(res.status).toBe(403)
		expect(calls).toHaveLength(0)
	})

	it('refuses a label that does not exist instead of creating it', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read_write'))

		const res = await labels({ thread_id: 'thr1', add_labels: ['Nope'] })

		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'Receipts',
		)
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('refuses to trash a thread through labels', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read_write'))

		const res = await labels({ thread_id: 'thr1', add_labels: ['TRASH'] })

		expect(res.status).toBe(400)
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('refuses a call that changes nothing', async () => {
		const calls = stubGmail()
		const { labels } = await setup(one('read_write'))

		const res = await labels({ thread_id: 'thr1' })

		expect(res.status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

describe('with several Gmail accounts', () => {
	const two = (second: Access) => [
		{ address: 'sender@example.com', token: 'tok-first', access: 'read' as const },
		{ address: 'Other@example.com', token: 'tok-second', access: second },
	]

	it('reads the account named in the request, matched without regard to case', async () => {
		const calls = stubGmail()
		const { search } = await setup(two('read'))

		const res = await search('?account=other%40EXAMPLE.com')

		expect(res.status).toBe(200)
		expect(new Set(calls.map((c) => c.token))).toEqual(new Set(['Bearer tok-second']))
	})

	it('uses the first connected account when none is named', async () => {
		const calls = stubGmail()
		const { thread } = await setup(two('read'))

		const res = await thread('?thread_id=thr1')

		expect(res.status).toBe(200)
		expect(new Set(calls.map((c) => c.token))).toEqual(new Set(['Bearer tok-first']))
	})

	it('needs read and write on the named account to archive, whatever the other account allows', async () => {
		const calls = stubGmail()
		const { labels } = await setup(two('read'))

		const res = await labels({ thread_id: 'thr1', archive: true, account: 'other@example.com' })

		expect(res.status).toBe(404)
		expect(calls).toHaveLength(0)
	})
})
