import { OpenAPIHono } from '@hono/zod-openapi'
import { relationships } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { CONVERSATION_FILE_LINK_TYPE } from '../../lib/conversation-file-links'
import { insertConversation, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

// A call from an agent's computer: the caller's session key names the session, and no
// X-Maskin-Session-Id header is sent.
function createApp(opts: { apiKeySessionId?: string | null } = {}) {
	const bytes = new Map<string, Buffer>()
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, getTestActorId() as never)
		c.set('workspaceRole' as never, 'owner' as never)
		c.set('apiKeySessionId' as never, (opts.apiKeySessionId ?? null) as never)
		c.set(
			'storageProvider' as never,
			{
				put: async (key: string, data: Buffer) => void bytes.set(key, data),
				get: async (key: string) => bytes.get(key) ?? Buffer.alloc(0),
			} as never,
		)
		await next()
	})
	app.route('/api/files', filesRoutes as never)
	return app
}

describe('POST /api/files chat and work item links', () => {
	let workspaceId: string
	const actorId = () => getTestActorId()

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, actorId())).id
	})

	const headers = () => ({ 'X-Workspace-Id': workspaceId })
	const body = (extra: Record<string, unknown> = {}) => ({
		name: 'render.txt',
		mime_type: 'text/plain',
		content: 'hello',
		...extra,
	})
	const linksTo = (fileId: string, type: string) =>
		db
			.select()
			.from(relationships)
			.where(and(eq(relationships.targetId, fileId), eq(relationships.type, type)))

	it('links a file made through a session key to the chat of that session, with no header', async () => {
		const chat = await insertConversation(db, workspaceId, actorId())
		const session = await insertSession(db, workspaceId, actorId(), actorId(), {
			conversationId: chat?.id,
		})

		const res = await createApp({ apiKeySessionId: session?.id }).request(
			jsonRequest('POST', '/api/files', body(), headers()),
		)
		expect(res.status).toBe(201)
		const { id } = (await res.json()) as { id: string }

		const chatLinks = await linksTo(id, CONVERSATION_FILE_LINK_TYPE)
		expect(chatLinks).toHaveLength(1)
		expect(chatLinks[0]?.sourceId).toBe(chat?.id)
		expect(await linksTo(id, 'produced_by')).toHaveLength(1)
	})

	it('writes no links for a caller with no session', async () => {
		const res = await createApp().request(jsonRequest('POST', '/api/files', body(), headers()))
		const { id } = (await res.json()) as { id: string }

		expect(await linksTo(id, CONVERSATION_FILE_LINK_TYPE)).toHaveLength(0)
		expect(await linksTo(id, 'produced_by')).toHaveLength(0)
	})

	it('links the named chat instead of the session chat, and attaches the named work item', async () => {
		const sessionChat = await insertConversation(db, workspaceId, actorId())
		const namedChat = await insertConversation(db, workspaceId, actorId())
		const task = await insertObject(db, workspaceId, actorId(), { type: 'task', status: 'todo' })
		const session = await insertSession(db, workspaceId, actorId(), actorId(), {
			conversationId: sessionChat?.id,
		})

		const res = await createApp({ apiKeySessionId: session?.id }).request(
			jsonRequest(
				'POST',
				'/api/files',
				body({ conversation_id: namedChat?.id, object_id: task.id }),
				headers(),
			),
		)
		expect(res.status).toBe(201)
		const { id } = (await res.json()) as { id: string }

		const chatLinks = await linksTo(id, CONVERSATION_FILE_LINK_TYPE)
		expect(chatLinks.map((r) => r.sourceId)).toEqual([namedChat?.id])
		const attached = await linksTo(id, 'attached')
		expect(attached.map((r) => r.sourceId)).toEqual([task.id])
	})

	it('refuses a chat or work item from another workspace and creates nothing', async () => {
		const otherWorkspaceId = (await insertWorkspace(db, actorId())).id
		const foreignChat = await insertConversation(db, otherWorkspaceId, actorId())
		const foreignTask = await insertObject(db, otherWorkspaceId, actorId(), {
			type: 'task',
			status: 'todo',
		})

		for (const extra of [{ conversation_id: foreignChat?.id }, { object_id: foreignTask.id }]) {
			const res = await createApp().request(
				jsonRequest('POST', '/api/files', body(extra), headers()),
			)
			expect(res.status).toBe(404)
		}
	})
})
