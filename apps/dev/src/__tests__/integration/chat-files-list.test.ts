import { conversationParticipants, files, messages, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { CHAT_FILES_LIST_MAX } from '../../services/chat-session-context'
import { evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

// A session that starts in a chat is handed the chat's files in its seed prompt, read from the
// attachments on the chat's messages. Real Postgres and a real SessionManager; only the container
// launch is switched off (autoStart false).

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

describe('Files in this chat list for a new chat session (Integration)', () => {
	let manager: SessionManager
	let personId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let createSession: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.mocked(capturePosthogEvent).mockClear()
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
		const conversation = await insertConversation(db, workspaceId, personId)
		conversationId = conversation.id
		await db.insert(conversationParticipants).values([
			{ conversationId, actorId: personId },
			{ conversationId, actorId: agentId },
		])
		manager = new SessionManager(db, stubStorage())
		const original = manager.createSession.bind(manager)
		createSession = vi
			.spyOn(manager, 'createSession')
			.mockImplementation((ws, params) => original(ws, { ...params, autoStart: false }))
		configureSessionLifecycle({ db, sessionManager: manager })
	})

	afterEach(async () => {
		await manager.stop()
	})

	async function upload(name: string, mimeType = 'video/quicktime', sizeBytes = 940_000_000) {
		const [file] = await db
			.insert(files)
			.values({
				workspaceId,
				name,
				mimeType,
				sizeBytes,
				storageKey: `test/${name}`,
				createdBy: personId,
			})
			.returning()
		if (!file) throw new Error('failed to insert file')
		return file
	}

	async function post(content: string, attachmentIds: Array<{ id: string; name: string }> = []) {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId: personId,
				content,
				metadata:
					attachmentIds.length > 0
						? { attachments: attachmentIds.map((a) => ({ file_id: a.id, name: a.name })) }
						: null,
			})
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	const respond = (messageId: number) =>
		evaluateAndRespond({ db, sessionManager: manager, workspaceId, conversationId, messageId })

	const seedPrompt = () => {
		const params = createSession.mock.calls[0]?.[1] as { actionPrompt: string } | undefined
		if (!params) throw new Error('no session was started')
		return params.actionPrompt
	}

	const seededEvent = () =>
		vi.mocked(capturePosthogEvent).mock.calls.find(([name]) => name === 'chat_session_seeded')

	it('names a file from the first message in a chat of more than 15 messages', async () => {
		const video = await upload('IMG_9992.MOV')
		await post('here is the video', [{ id: video.id, name: video.name }])
		for (let i = 1; i <= 20; i++) await post(`later message ${i}`)
		const lastId = await post('can you cut it?')

		await respond(lastId)

		const prompt = seedPrompt()
		// The history holds the last 15 messages, so the first one is not in it.
		expect(prompt).not.toContain('here is the video')
		expect(prompt).toContain('Files in this chat')
		expect(prompt).toContain(`IMG_9992.MOV (video/quicktime, 896 MB) — file id: ${video.id}`)
		expect(prompt).toContain('uploaded by')
		expect(seededEvent()?.[2]).toMatchObject({
			workspace_id: workspaceId,
			conversation_id: conversationId,
			files_listed_count: 1,
		})
	})

	it('lists at most 50 files, newest first, and says how many older ones are left out', async () => {
		const total = CHAT_FILES_LIST_MAX + 7
		for (let i = 1; i <= total; i++) {
			const f = await upload(`clip-${String(i).padStart(3, '0')}.mp4`, 'video/mp4', 1024)
			await post(`upload ${i}`, [{ id: f.id, name: f.name }])
		}
		const lastId = await post('what do we have?')

		await respond(lastId)

		const prompt = seedPrompt()
		const listed = prompt.match(/^- clip-\d{3}\.mp4 /gm) ?? []
		expect(listed).toHaveLength(CHAT_FILES_LIST_MAX)
		expect(prompt).toContain('clip-057.mp4')
		expect(prompt).not.toContain('clip-007.mp4')
		expect(prompt).toContain('7 older files not shown, use the chat files lookup')
		expect(seededEvent()?.[2]).toMatchObject({ files_listed_count: CHAT_FILES_LIST_MAX })
	})

	it('adds no list and reports zero when the chat has no files', async () => {
		const lastId = await post('hello')

		await respond(lastId)

		expect(seedPrompt()).not.toContain('Files in this chat')
		expect(seededEvent()?.[2]).toMatchObject({ files_listed_count: 0 })
	})

	it('leaves out a file whose row is gone and a file from another workspace', async () => {
		const kept = await upload('kept.pdf', 'application/pdf', 2048)
		const gone = await upload('gone.pdf', 'application/pdf', 2048)
		const otherWorkspaceId = (await insertWorkspace(db, personId)).id
		const [foreign] = await db
			.insert(files)
			.values({
				workspaceId: otherWorkspaceId,
				name: 'foreign.pdf',
				mimeType: 'application/pdf',
				sizeBytes: 1,
				storageKey: 'test/foreign.pdf',
				createdBy: personId,
			})
			.returning()
		if (!foreign) throw new Error('failed to insert file')
		await post('three files', [
			{ id: kept.id, name: kept.name },
			{ id: gone.id, name: gone.name },
			{ id: foreign.id, name: foreign.name },
		])
		await db.delete(files).where(eq(files.id, gone.id))
		const lastId = await post('hi')

		await respond(lastId)

		const prompt = seedPrompt()
		expect(prompt).toContain('kept.pdf')
		expect(prompt).not.toContain('gone.pdf')
		expect(prompt).not.toContain('foreign.pdf')
		expect(seededEvent()?.[2]).toMatchObject({ files_listed_count: 1 })
	})
})
