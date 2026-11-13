import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, messages, relationships } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { backfillChatAttachedFiles } from '../../services/chat-files-backfill'
import { insertConversationMessage } from '../../services/conversation-messages'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertConversation, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')
const { default: conversationsRoutes } = await import('../../routes/conversations')

// A chat and the files attached in it are joined by `conversation -> file` `has_file` edges:
// written when a message is stored (carrying the message id), skipped for a file that is missing
// or in another workspace (the message still posts), and filled in for old messages by the
// one-off backfill.

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function createApp() {
	const bytes = new Map<string, Buffer>()
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
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		c.set('workspaceRole' as never, 'owner' as never)
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
	app.route('/api/conversations', conversationsRoutes as never)
	return app
}

type FileRow = { id: string; name: string }

describe('chat to file has_file edges (Integration)', () => {
	let personId: string
	let workspaceId: string
	let conversationId: string
	let app: ReturnType<typeof createApp>

	const headers = (ws = workspaceId) => ({ 'X-Workspace-Id': ws })

	async function createFile(name: string, ws = workspaceId, mime = 'text/plain') {
		const res = await app.request(
			jsonRequest('POST', '/api/files', { name, mime_type: mime, content: 'x' }, headers(ws)),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as FileRow
	}

	const edgesOf = (id = conversationId) =>
		db
			.select()
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceType, 'conversation'),
					eq(relationships.sourceId, id),
					eq(relationships.type, 'has_file'),
				),
			)

	async function say(content: string, attachments?: Array<{ file_id: string; name?: string }>) {
		const created = await insertConversationMessage(db, {
			conversationId,
			workspaceId,
			actorId: personId,
			content,
			metadata: attachments ? { attachments } : null,
			sessionId: null,
		})
		if (!created) throw new Error('message not stored')
		return created
	}

	beforeEach(async () => {
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
		conversationId = (await insertConversation(db, workspaceId, personId)).id
		await db.insert(conversationParticipants).values({ conversationId, actorId: personId })
		app = createApp()
	})

	describe('when a message is stored', () => {
		it('adds one edge per file, carrying the message id, and none for a file that is not in the workspace', async () => {
			const video = await createFile('IMG_9992.MOV', workspaceId, 'video/quicktime')
			const plan = await createFile('plan.pdf', workspaceId, 'application/pdf')
			const foreign = await createFile('foreign.txt', (await insertWorkspace(db, personId)).id)

			const first = await say('here', [
				{ file_id: video.id },
				{ file_id: plan.id },
				{ file_id: video.id },
				{ file_id: foreign.id },
				{ file_id: crypto.randomUUID() },
			])
			await say('the video again', [{ file_id: video.id }])

			const edges = await edgesOf()
			expect(edges.map((e) => e.targetId).sort()).toEqual([video.id, plan.id].sort())
			expect(edges.every((e) => e.targetType === 'file' && e.createdBy === personId)).toBe(true)
			expect(edges.every((e) => (e.metadata as { messageId: number }).messageId === first.id)).toBe(
				true,
			)
		})

		it('adds no edge for a message without attachments', async () => {
			await say('just words')
			expect(await edgesOf()).toHaveLength(0)
		})
	})

	describe('POST /api/conversations/:id/messages', () => {
		const post = (body: Record<string, unknown>) =>
			app.request(
				jsonRequest('POST', `/api/conversations/${conversationId}/messages`, body, headers()),
			)

		it('posts the message and links only the files of this workspace', async () => {
			const foreign = await createFile('foreign.txt', (await insertWorkspace(db, personId)).id)
			const real = await createFile('real.txt')
			const missing = crypto.randomUUID()

			const res = await post({
				content: 'see attached',
				metadata: {
					attachments: [{ file_id: real.id }, { file_id: missing }, { file_id: foreign.id }],
				},
			})

			expect(res.status).toBe(201)
			expect(
				await db.select().from(messages).where(eq(messages.conversationId, conversationId)),
			).toHaveLength(1)
			expect((await edgesOf()).map((e) => e.targetId)).toEqual([real.id])
		})

		it('stores the message and links the file when every file is real', async () => {
			const real = await createFile('real.txt')
			const res = await post({
				content: 'see attached',
				metadata: { attachments: [{ file_id: real.id }] },
			})
			expect(res.status).toBe(201)
			expect((await edgesOf()).map((e) => e.targetId)).toEqual([real.id])
		})
	})

	describe('POST /api/conversations with a first message', () => {
		const open = (metadata: Record<string, unknown>) =>
			app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'Video',
						participant_actor_ids: [],
						initial_message: 'my raw video',
						initial_message_metadata: metadata,
					},
					headers(),
				),
			)

		it('links the file attached to the first message, the way the Regnskab video was sent', async () => {
			const video = await createFile('IMG_9992.MOV', workspaceId, 'video/quicktime')
			const res = await open({ attachments: [{ file_id: video.id }] })
			expect(res.status).toBe(201)
			const created = (await res.json()) as { id: string }
			const [edge] = await edgesOf(created.id)
			expect(edge?.targetId).toBe(video.id)
			expect((edge?.metadata as { messageId: number }).messageId).toBeGreaterThan(0)
		})

		it('creates the chat and links nothing for an unknown file id', async () => {
			const res = await open({ attachments: [{ file_id: crypto.randomUUID() }] })
			expect(res.status).toBe(201)
			const created = (await res.json()) as { id: string }
			expect(await edgesOf(created.id)).toHaveLength(0)
		})
	})

	describe('backfill of old messages', () => {
		// Messages stored before the live writer existed carry the attachment list and no edge.
		async function legacy(attachments: unknown, over: Partial<typeof messages.$inferInsert> = {}) {
			const [row] = await db
				.insert(messages)
				.values({
					conversationId,
					actorId: personId,
					content: 'old',
					metadata: { attachments } as never,
					...over,
				})
				.returning()
			return row as typeof messages.$inferSelect
		}

		async function seedLegacy() {
			const video = await createFile('IMG_9992.MOV')
			const plan = await createFile('plan.pdf')
			const deletedOnly = await createFile('deleted.txt')
			const foreign = await createFile('foreign.txt', (await insertWorkspace(db, personId)).id)
			const firstVideo = await legacy([{ file_id: video.id }, { file_id: plan.id }])
			await legacy([{ file_id: video.id }])
			await legacy([{ file_id: deletedOnly.id }], { deletedAt: new Date(), metadata: null })
			await legacy([
				{ file_id: foreign.id },
				{ file_id: crypto.randomUUID() },
				{ file_id: 'not-a-uuid' },
				{ name: 'no id' },
			])
			await legacy('not a list')
			await legacy([{ file_id: plan.id }], { kind: 'system' })
			return { video, plan, firstVideo }
		}

		it('a dry run counts and writes nothing', async () => {
			await seedLegacy()
			const counts = await backfillChatAttachedFiles(db, { apply: false, workspaceId })
			expect(counts).toMatchObject({
				linksAdded: 2,
				skippedMissing: 1,
				skippedOtherWorkspace: 1,
				skippedBadId: 2,
			})
			expect(await edgesOf()).toHaveLength(0)
		})

		it('links each file once, to its earliest message, and a second run adds zero', async () => {
			const { video, plan, firstVideo } = await seedLegacy()

			const first = await backfillChatAttachedFiles(db, { apply: true, workspaceId, batchSize: 2 })
			expect(first).toMatchObject({
				linksAdded: 2,
				skippedMissing: 1,
				skippedOtherWorkspace: 1,
				skippedBadId: 2,
			})

			const edges = await edgesOf()
			expect(edges.map((e) => e.targetId).sort()).toEqual([video.id, plan.id].sort())
			const videoEdge = edges.find((e) => e.targetId === video.id)
			expect((videoEdge?.metadata as { messageId: number }).messageId).toBe(firstVideo.id)
			expect(edges.every((e) => e.createdBy === personId)).toBe(true)

			const second = await backfillChatAttachedFiles(db, { apply: true, workspaceId })
			expect(second.linksAdded).toBe(0)
			expect(second.alreadyLinked).toBe(2)
			expect(await edgesOf()).toHaveLength(2)
		})

		it('does not touch another workspace when limited to one', async () => {
			await seedLegacy()
			const otherWorkspace = (await insertWorkspace(db, personId)).id
			const counts = await backfillChatAttachedFiles(db, {
				apply: true,
				workspaceId: otherWorkspace,
			})
			expect(counts.messagesScanned).toBe(0)
			expect(await edgesOf()).toHaveLength(0)
		})
	})
})
