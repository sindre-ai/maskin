import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversations,
	messages,
	objects,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { draftTaskStateToMetadata, updateObjectSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * POST /sessions/:id/draft — the route the `post_draft` MCP tool posts to when
 * it runs inside a chat session.
 *
 * Against real Postgres because the behaviour under test is two writes that must
 * land together: a task holding the draft and the `messages` row that points at
 * it. The flat `draft_*` metadata keys also have to pass the real object write
 * schema, which a mocked DB cannot show.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function createSessionsApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'agent')
		c.set('sessionManager', {
			createSession: vi.fn(),
			writeInput: vi.fn(),
		} as unknown as Env['Variables']['sessionManager'])
		await next()
	})

	app.route('/api/sessions', sessionsRoutes)
	return app
}

function postDraft(sessionId: string, workspaceId: string, body: Record<string, unknown>) {
	return jsonRequest('POST', `/api/sessions/${sessionId}/draft`, body, {
		'X-Workspace-Id': workspaceId,
	})
}

const EMAIL = {
	kind: 'email',
	to: 'Mette Holm, Northwind',
	subject: 'Following up on our call',
	body: 'Hi Mette,\n\nBest,\nSeb',
}

describe('POST /sessions/:id/draft', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id

		const agent = await insertActor(db, { type: 'agent' })
		if (!agent) throw new Error('failed to seed agent')
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id
	})

	async function chatSession() {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		return session
	}

	async function messagesFor(conversation: string) {
		return db.select().from(messages).where(eq(messages.conversationId, conversation))
	}

	async function tasksIn(workspace: string) {
		return db.select().from(objects).where(eq(objects.workspaceId, workspace))
	}

	it('creates the task and posts a card that points at it', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(postDraft(session.id, workspaceId, EMAIL))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { message_id: number; object_id: string }

		const [task] = await tasksIn(workspaceId)
		expect(task?.id).toBe(body.object_id)
		expect(task?.type).toBe('task')
		// This workspace's task statuses have no in_review or backlog, and `todo` would
		// dispatch a driver, so the draft waits in the one status that starts nothing.
		expect(task?.status).toBe('blocked')
		expect(task?.driver).toBe(agentId)
		expect(task?.content).toBe(EMAIL.body)
		expect(task?.metadata).toMatchObject({
			draft_state: 'draft',
			draft_subject: EMAIL.subject,
			draft_original_subject: EMAIL.subject,
			draft_original_body: EMAIL.body,
			draft_approved_at: null,
		})

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(body.message_id)
		expect(rows[0]?.actorId).toBe(agentId)
		const metadata = rows[0]?.metadata as { draft?: Record<string, unknown> }
		expect(metadata.draft).toEqual({ object_id: task?.id, kind: 'email', to: EMAIL.to })
		// The markdown fallback is what every non-chat reader sees, so it has to
		// carry the draft itself and not just a pointer.
		expect(rows[0]?.content).toContain('> Hi Mette,')
		expect(rows[0]?.content).toContain(EMAIL.subject)
	})

	it('writes metadata the object update route accepts, so edits and approval can save', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)
		await app.request(postDraft(session.id, workspaceId, EMAIL))
		const [task] = await tasksIn(workspaceId)

		const parsed = updateObjectSchema.safeParse({
			content: 'Edited.',
			metadata: {
				...task?.metadata,
				...draftTaskStateToMetadata({
					state: 'approved',
					original_body: EMAIL.body,
					approved_at: new Date().toISOString(),
				}),
			},
		})

		expect(parsed.success).toBe(true)
	})

	describe('a workspace-defined object type', () => {
		async function defineType(statuses: string[]) {
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
			const settings = (ws?.settings ?? {}) as { statuses?: Record<string, string[]> }
			await db
				.update(workspaces)
				.set({
					settings: { ...settings, statuses: { ...settings.statuses, outbound_message: statuses } },
				})
				.where(eq(workspaces.id, workspaceId))
		}

		it("creates the draft as the requested type, in the type's own first status when it has no in_review", async () => {
			await defineType(['drafted', 'approved_to_send', 'sent'])
			const session = await chatSession()
			const app = createSessionsApp(agentId)

			const res = await app.request(
				postDraft(session.id, workspaceId, {
					kind: 'text',
					label: 'Slack message',
					approve_label: 'Approve and post',
					object_type: 'outbound_message',
					body: 'Heads up: deploy at 14:00.',
				}),
			)
			expect(res.status).toBe(200)

			const [row] = await tasksIn(workspaceId)
			expect(row).toMatchObject({ type: 'outbound_message', status: 'drafted' })
			const [message] = await messagesFor(conversationId)
			expect((message?.metadata as { draft?: Record<string, unknown> }).draft).toMatchObject({
				kind: 'text',
				label: 'Slack message',
				approve_label: 'Approve and post',
			})
		})

		it('prefers in_review when the type has it, and accepts an explicit status', async () => {
			await defineType(['drafted', 'in_review', 'sent'])
			const session = await chatSession()
			const app = createSessionsApp(agentId)
			const base = { kind: 'text', object_type: 'outbound_message', body: 'Hi' }

			await app.request(postDraft(session.id, workspaceId, base))
			await app.request(postDraft(session.id, workspaceId, { ...base, status: 'sent' }))

			const rows = await tasksIn(workspaceId)
			expect(rows.map((r) => r.status).sort()).toEqual(['in_review', 'sent'])
		})

		it('puts a task in backlog when there is no in_review, never in todo', async () => {
			await defineType(['x'])
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
			const settings = ws?.settings as { statuses: Record<string, string[]> }
			await db
				.update(workspaces)
				.set({
					settings: {
						...settings,
						statuses: { ...settings.statuses, task: ['todo', 'backlog', 'in_progress', 'done'] },
					},
				})
				.where(eq(workspaces.id, workspaceId))
			const session = await chatSession()
			const app = createSessionsApp(agentId)

			await app.request(postDraft(session.id, workspaceId, { kind: 'text', body: 'Hi' }))

			expect((await tasksIn(workspaceId))[0]?.status).toBe('backlog')
		})

		it('asks for a status when every task status starts or ends work', async () => {
			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
			const settings = ws?.settings as { statuses: Record<string, string[]> }
			await db
				.update(workspaces)
				.set({
					settings: { ...settings, statuses: { ...settings.statuses, task: ['todo', 'done'] } },
				})
				.where(eq(workspaces.id, workspaceId))
			const session = await chatSession()
			const app = createSessionsApp(agentId)

			const res = await app.request(
				postDraft(session.id, workspaceId, { kind: 'text', body: 'Hi' }),
			)

			expect(res.status).toBe(400)
			expect(await tasksIn(workspaceId)).toHaveLength(0)
		})

		it('rejects a type the workspace does not define and lists the ones it does', async () => {
			const session = await chatSession()
			const app = createSessionsApp(agentId)

			const res = await app.request(
				postDraft(session.id, workspaceId, {
					kind: 'text',
					object_type: 'carrier_pigeon',
					body: 'Hi',
				}),
			)

			expect(res.status).toBe(400)
			expect(JSON.stringify(await res.json())).toContain('task')
			expect(await tasksIn(workspaceId)).toHaveLength(0)
		})

		it('rejects a status the type does not have', async () => {
			await defineType(['drafted', 'sent'])
			const session = await chatSession()
			const app = createSessionsApp(agentId)

			const res = await app.request(
				postDraft(session.id, workspaceId, {
					kind: 'text',
					object_type: 'outbound_message',
					status: 'in_review',
					body: 'Hi',
				}),
			)

			expect(res.status).toBe(400)
			expect(await tasksIn(workspaceId)).toHaveLength(0)
		})
	})

	it('logs a created event for the task', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)
		const res = await app.request(postDraft(session.id, workspaceId, EMAIL))
		const { object_id } = (await res.json()) as { object_id: string }

		const rows = await db.select().from(events).where(eq(events.entityId, object_id))

		expect(rows.map((r) => r.action)).toContain('created')
	})

	it('derives the task title from the kind and recipient', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		await app.request(postDraft(session.id, workspaceId, EMAIL))

		const [task] = await tasksIn(workspaceId)
		expect(task?.title).toBe('Approve email to Mette Holm, Northwind')
	})

	it('stores the character limit on the card and takes no email fields for a LinkedIn note', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			postDraft(session.id, workspaceId, {
				kind: 'linkedin_message',
				body: 'Hi Tom, congrats on the new role.',
				char_limit: 300,
			}),
		)
		expect(res.status).toBe(200)

		const [row] = await messagesFor(conversationId)
		const metadata = row?.metadata as { draft?: Record<string, unknown> }
		expect(metadata.draft).toMatchObject({ kind: 'linkedin_message', char_limit: 300 })
	})

	it('accepts a channel it has never heard of and names the task after it', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			postDraft(session.id, workspaceId, {
				kind: 'instagram_caption',
				body: 'New drop tomorrow.',
				char_limit: 2200,
			}),
		)

		expect(res.status).toBe(200)
		const [task] = await tasksIn(workspaceId)
		expect(task?.title).toBe('Approve instagram caption')
	})

	it('rejects an email without a subject and creates nothing', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			postDraft(session.id, workspaceId, { kind: 'email', to: 'Mette', body: 'Hi' }),
		)

		expect(res.status).toBe(400)
		expect(await tasksIn(workspaceId)).toHaveLength(0)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('rejects a draft that is over its character limit', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			postDraft(session.id, workspaceId, {
				kind: 'linkedin_message',
				body: 'x'.repeat(301),
				char_limit: 300,
			}),
		)

		expect(res.status).toBe(400)
		expect(await tasksIn(workspaceId)).toHaveLength(0)
	})

	it('answers 409 for a session with no chat, and creates nothing', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(postDraft(session.id, workspaceId, EMAIL))

		expect(res.status).toBe(409)
		expect(await tasksIn(workspaceId)).toHaveLength(0)
	})

	it('answers 403 when the caller is not the actor that owns the session', async () => {
		const session = await chatSession()
		const app = createSessionsApp(humanId)

		const res = await app.request(postDraft(session.id, workspaceId, EMAIL))

		expect(res.status).toBe(403)
		expect(await tasksIn(workspaceId)).toHaveLength(0)
	})

	it('answers 404 for an unknown session', async () => {
		const app = createSessionsApp(agentId)

		const res = await app.request(
			postDraft('00000000-0000-4000-8000-000000000000', workspaceId, EMAIL),
		)

		expect(res.status).toBe(404)
	})
})
