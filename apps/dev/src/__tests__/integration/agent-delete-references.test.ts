import { randomUUID } from 'node:crypto'
import {
	actors,
	conversationPendingTurns,
	conversations,
	extensions,
	fileComments,
	fileProposalChanges,
	fileProposals,
	fileUploads,
	files,
	integrations,
	messages,
	starState,
	triggers,
	voiceSessions,
	workspaceInvitations,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq, sql } from 'drizzle-orm'
import { AGENT_DELETE_HANDLED_REFERENCES } from '../../lib/agent-delete-references'
import {
	buildFile,
	buildIntegration,
	buildTrigger,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, setTestAgentStorage } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { AgentStorageManager } = await import('../../services/agent-storage')

/**
 * Deleting an agent returned a 500 whenever the agent was named in a table whose foreign key
 * to actors has no cascade and that the delete route did not clean up (a chat it started, a
 * starred item, a file comment, and so on). Against real Postgres because the failure is a
 * constraint, which a mocked DB cannot show.
 */

const emptyStorage: StorageProvider = {
	async put() {},
	async get() {
		throw new Error('not found')
	},
	async list() {
		return []
	},
	async listWithMetadata() {
		return []
	},
	async delete() {},
	async exists() {
		return false
	},
	async ensureBucket() {},
}

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Agent delete — every foreign key to actors is handled', () => {
	it('lists every foreign key to actors that has no cascade or set-null rule', async () => {
		// A new foreign key to actors with the default NO ACTION rule makes the delete route fail
		// with a 500 until the route clears it. When this fails: clean up the new column in the
		// delete route (actors.ts), then add it to AGENT_DELETE_HANDLED_REFERENCES.
		const rows = await db.execute<{ ref: string }>(sql`
			SELECT c.conrelid::regclass::text || '.' || a.attname AS ref
			FROM pg_constraint c
			JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			WHERE c.contype = 'f'
				AND c.confrelid = 'actors'::regclass
				AND c.confdeltype IN ('a', 'r')
			ORDER BY 1
		`)
		const inDatabase = [...rows].map((r) => r.ref).sort()
		expect(inDatabase).toEqual([...AGENT_DELETE_HANDLED_REFERENCES].sort())
	})
})

describe('Agent delete — rows that name the agent', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string

	beforeEach(async () => {
		setTestAgentStorage(new AgentStorageManager(emptyStorage, db))
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Delete Me' })).id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
	})

	afterAll(() => {
		setTestAgentStorage(undefined)
	})

	async function deleteAgent() {
		return createApp().request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, { 'x-workspace-id': workspaceId }),
		)
	}

	async function actorRows() {
		return db.select().from(actors).where(eq(actors.id, agentId))
	}

	it('deletes an agent that started a chat and keeps the chat', async () => {
		const chat = await insertConversation(db, workspaceId, agentId)

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		expect(await actorRows()).toHaveLength(0)
		const [after] = await db.select().from(conversations).where(eq(conversations.id, chat.id))
		expect(after.createdBy).toBe(humanId)
	})

	it('deletes an agent with a queued chat turn addressed to it', async () => {
		const chat = await insertConversation(db, workspaceId, humanId)
		const [message] = await db
			.insert(messages)
			.values({ conversationId: chat.id, actorId: humanId, content: 'fake message' })
			.returning()
		await db.insert(conversationPendingTurns).values({
			conversationId: chat.id,
			actorId: agentId,
			messageId: message.id,
			payload: {},
		})

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const turns = await db
			.select()
			.from(conversationPendingTurns)
			.where(eq(conversationPendingTurns.conversationId, chat.id))
		expect(turns).toHaveLength(0)
	})

	it('deletes an agent that starred an item', async () => {
		await db
			.insert(starState)
			.values({ actorId: agentId, entityType: 'object', entityId: randomUUID(), workspaceId })

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const stars = await db.select().from(starState).where(eq(starState.actorId, agentId))
		expect(stars).toHaveLength(0)
	})

	it('deletes an agent that invited someone and keeps the invitation', async () => {
		const [invite] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'invitee@example.invalid',
				role: 'member',
				tokenHash: `fake-hash-${randomUUID()}`,
				invitedByActorId: agentId,
				expiresAt: new Date(Date.now() + 86_400_000),
			})
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [after] = await db
			.select()
			.from(workspaceInvitations)
			.where(eq(workspaceInvitations.id, invite.id))
		expect(after.invitedByActorId).toBe(humanId)
	})

	it('deletes an agent that wrote or resolved file comments and keeps them', async () => {
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: humanId }))
			.returning()
		const [byAgent] = await db
			.insert(fileComments)
			.values({
				fileId: file.id,
				positionDoc: { x: 0.1, y: 0.2 },
				authorId: agentId,
				body: 'fake comment by agent',
			})
			.returning()
		const [resolvedByAgent] = await db
			.insert(fileComments)
			.values({
				fileId: file.id,
				positionDoc: { x: 0.3, y: 0.4 },
				authorId: humanId,
				body: 'fake comment by person',
				resolvedAt: new Date(),
				resolvedBy: agentId,
			})
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [authored] = await db.select().from(fileComments).where(eq(fileComments.id, byAgent.id))
		expect(authored.authorId).toBe(humanId)
		const [resolved] = await db
			.select()
			.from(fileComments)
			.where(eq(fileComments.id, resolvedByAgent.id))
		expect(resolved.resolvedBy).toBeNull()
	})

	it('deletes an agent that proposed or decided file changes and keeps them', async () => {
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: humanId }))
			.returning()
		const [proposal] = await db
			.insert(fileProposals)
			.values({ fileId: file.id, workspaceId, authorId: agentId, baseSha256: 'fake-sha' })
			.returning()
		const [humanProposal] = await db
			.insert(fileProposals)
			.values({ fileId: file.id, workspaceId, authorId: humanId, baseSha256: 'fake-sha' })
			.returning()
		const [change] = await db
			.insert(fileProposalChanges)
			.values({
				proposalId: humanProposal.id,
				ordinal: 0,
				oldText: 'old',
				newText: 'new',
				status: 'accepted',
				decidedBy: agentId,
			})
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [proposalAfter] = await db
			.select()
			.from(fileProposals)
			.where(eq(fileProposals.id, proposal.id))
		expect(proposalAfter.authorId).toBe(humanId)
		const [changeAfter] = await db
			.select()
			.from(fileProposalChanges)
			.where(eq(fileProposalChanges.id, change.id))
		expect(changeAfter.decidedBy).toBeNull()
	})

	it('deletes an agent that began a file upload and keeps the upload', async () => {
		const [upload] = await db
			.insert(fileUploads)
			.values({
				workspaceId,
				fileId: randomUUID(),
				name: 'fake.bin',
				mimeType: 'application/octet-stream',
				sizeBytes: 10,
				storageKey: `fake/${randomUUID()}`,
				s3UploadId: 'fake-upload',
				partSize: 10,
				partCount: 1,
				createdBy: agentId,
				expiresAt: new Date(Date.now() + 86_400_000),
			})
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [after] = await db.select().from(fileUploads).where(eq(fileUploads.id, upload.id))
		expect(after.createdBy).toBe(humanId)
	})

	it('deletes an agent that created an extension and keeps the extension', async () => {
		const [extension] = await db
			.insert(extensions)
			.values({ workspaceId, slug: `fake-${randomUUID()}`, name: 'Fake', createdBy: agentId })
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [after] = await db.select().from(extensions).where(eq(extensions.id, extension.id))
		expect(after.createdBy).toBeNull()
	})

	it('deletes an agent that took part in a voice call', async () => {
		const [call] = await db
			.insert(voiceSessions)
			.values({ workspaceId, agentActorId: agentId, humanActorId: humanId, status: 'ended' })
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const calls = await db.select().from(voiceSessions).where(eq(voiceSessions.id, call.id))
		expect(calls).toHaveLength(0)
	})

	it('deletes an agent named as a trigger hand-off or escalation target and keeps the trigger', async () => {
		const [trigger] = await db
			.insert(triggers)
			.values(
				buildTrigger({
					workspaceId,
					targetActorId: humanId,
					createdBy: humanId,
					handsOffToActorId: agentId,
					escalatesToActorId: agentId,
				}),
			)
			.returning()

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const [after] = await db.select().from(triggers).where(eq(triggers.id, trigger.id))
		expect(after.handsOffToActorId).toBeNull()
		expect(after.escalatesToActorId).toBeNull()
	})

	it('deletes an agent that owns a connection and an agent that bills a workspace', async () => {
		const [connection] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId,
					provider: 'linkedin-unipile',
					externalId: null,
					createdBy: humanId,
					actorId: agentId,
				}),
			)
			.returning()
		await db
			.update(workspaces)
			.set({ billingOwnerId: agentId })
			.where(eq(workspaces.id, workspaceId))

		const res = await deleteAgent()

		expect(res.status).toBe(200)
		const kept = await db.select().from(integrations).where(eq(integrations.id, connection.id))
		expect(kept).toHaveLength(0)
		const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		expect(workspace.billingOwnerId).toBeNull()
	})
})
