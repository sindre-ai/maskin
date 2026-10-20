import {
	conversationParticipants,
	conversations,
	messages,
	voiceSessions,
	workspaces,
} from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	VOICE_IDLE_TIMEOUT_MS,
	ensureVoiceConversation,
	isTranscriptPersistenceEnabled,
	writeVoiceTranscriptLine,
} from '../../services/voice-transcript'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function seedCall(opts: { settings?: Record<string, unknown>; status?: string } = {}) {
	const humanId = getTestActorId()
	const agent = await insertActor(db, { type: 'agent', name: 'Chief of Staff', email: null })
	const ws = await insertWorkspace(db, humanId, opts.settings ? { settings: opts.settings } : {})
	const [row] = await db
		.insert(voiceSessions)
		.values({
			workspaceId: ws.id,
			agentActorId: agent.id,
			humanActorId: humanId,
			status: opts.status ?? 'pending',
			// Far enough in the past that a bump is unmistakable.
			timeoutAt: new Date('2026-01-01T00:00:00Z'),
		})
		.returning()
	if (!row) throw new Error('voice session insert failed')
	return { session: row, agent, ws, humanId }
}

const reload = async (id: string) =>
	(await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0]

describe('voice transcript writer — persist mode (default)', () => {
	it('lazily creates one conversation and writes each line as the right actor with voice metadata', async () => {
		const { session, agent, humanId } = await seedCall()

		const first = await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'search for the loops v4 bet',
		})
		const second = await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'assistant',
			text: 'The top hit is Loops v4 polish.',
		})

		expect(first?.conversationId).toBeTruthy()
		expect(second?.conversationId).toBe(first?.conversationId)

		const convs = await db.select().from(conversations)
		expect(convs).toHaveLength(1)
		expect(convs[0]?.title).toBe('Voice call with Chief of Staff')
		expect(convs[0]?.createdBy).toBe(humanId)

		const participants = await db.select().from(conversationParticipants)
		expect(participants.map((p) => p.actorId).sort()).toEqual([humanId, agent.id].sort())

		const rows = await db.select().from(messages).orderBy(messages.id)
		expect(
			rows.map((m) => ({ actor: m.actorId, content: m.content, metadata: m.metadata })),
		).toEqual([
			{
				actor: humanId,
				content: 'search for the loops v4 bet',
				metadata: { source: 'voice', voice_session_id: session.id },
			},
			{
				actor: agent.id,
				content: 'The top hit is Loops v4 polish.',
				metadata: { source: 'voice', voice_session_id: session.id },
			},
		])

		// The call now points at its conversation, and the chat's last-activity moved.
		expect((await reload(session.id))?.conversationId).toBe(first?.conversationId)
		expect(convs[0]?.lastMessageAt.getTime()).toBeGreaterThan(0)
	})

	it('pushes the idle deadline out from now on each written line', async () => {
		const { session } = await seedCall()
		const before = Date.now()
		await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'hello',
		})
		const after = (await reload(session.id))?.timeoutAt.getTime() ?? 0
		expect(after).toBeGreaterThanOrEqual(before + VOICE_IDLE_TIMEOUT_MS - 1_000)
	})

	it('does not revive a session that has already ended', async () => {
		const { session } = await seedCall({ status: 'ended' })
		await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'late line',
		})
		expect((await reload(session.id))?.timeoutAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
	})

	it('reuses the conversation a call was launched from instead of creating one', async () => {
		const { session, agent, ws, humanId } = await seedCall()
		const [existing] = await db
			.insert(conversations)
			.values({ workspaceId: ws.id, title: 'Existing chat', createdBy: humanId })
			.returning()
		if (!existing) throw new Error('conversation insert failed')
		await db.insert(conversationParticipants).values([
			{ conversationId: existing.id, actorId: humanId },
			{ conversationId: existing.id, actorId: agent.id },
		])
		await db
			.update(voiceSessions)
			.set({ conversationId: existing.id })
			.where(eq(voiceSessions.id, session.id))

		const written = await writeVoiceTranscriptLine(db, {
			session: { ...session, conversationId: existing.id },
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'continuing by voice',
		})

		expect(written?.conversationId).toBe(existing.id)
		expect(await db.select().from(conversations)).toHaveLength(1)
		expect(
			await db.select().from(messages).where(eq(messages.conversationId, existing.id)),
		).toHaveLength(1)
	})

	it('creates exactly one conversation when two writers race on a fresh call', async () => {
		const { session } = await seedCall()
		const ids = await Promise.all([
			ensureVoiceConversation(db, session, 'Chief of Staff'),
			ensureVoiceConversation(db, session, 'Chief of Staff'),
			ensureVoiceConversation(db, session, 'Chief of Staff'),
		])
		expect(new Set(ids).size).toBe(1)
		expect(await db.select().from(conversations)).toHaveLength(1)
	})

	it('writes nothing for a blank line', async () => {
		const { session } = await seedCall()
		expect(
			await writeVoiceTranscriptLine(db, {
				session,
				agentName: 'Chief of Staff',
				role: 'user',
				text: '   ',
			}),
		).toBeNull()
		expect(await db.select().from(messages)).toHaveLength(0)
		expect(await db.select().from(conversations)).toHaveLength(0)
	})
})

describe('voice transcript writer — workspace opt-out', () => {
	const optOut = { voice: { persist_transcripts: false } }

	it('writes no conversation, no message, and leaves transcript_storage_key null', async () => {
		const { session, ws } = await seedCall({ settings: optOut })
		expect(await isTranscriptPersistenceEnabled(db, ws.id)).toBe(false)

		const written = await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'this must not be stored',
		})

		expect(written).toBeNull()
		expect(await db.select().from(messages)).toHaveLength(0)
		expect(await db.select().from(conversations)).toHaveLength(0)
		const after = await reload(session.id)
		expect(after?.conversationId).toBeNull()
		expect(after?.transcriptStorageKey).toBeNull()
	})

	it('is read live: flipping the setting mid-call stops the next line', async () => {
		const { session, ws } = await seedCall()
		await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'stored',
		})
		await db.update(workspaces).set({ settings: optOut }).where(eq(workspaces.id, ws.id))
		await writeVoiceTranscriptLine(db, {
			session,
			agentName: 'Chief of Staff',
			role: 'user',
			text: 'not stored',
		})
		const rows = await db.select().from(messages)
		expect(rows.map((m) => m.content)).toEqual(['stored'])
	})

	it('defaults to persisting when the setting is absent or not exactly false', async () => {
		// Workspaces only: a second live call for the same human would trip the
		// one-live-call-per-human unique index, and the setting needs no call.
		const humanId = getTestActorId()
		const absent = await insertWorkspace(db, humanId)
		expect(await isTranscriptPersistenceEnabled(db, absent.id)).toBe(true)
		const empty = await insertWorkspace(db, humanId, { settings: { voice: {} } })
		expect(await isTranscriptPersistenceEnabled(db, empty.id)).toBe(true)
	})

	it('keeps a stored voice setting parseable by the strict workspace settings schema', async () => {
		// known-pitfalls.md: a key written to workspaces.settings but not modelled
		// in the schema makes every whole-object parse fail for unrelated readers.
		const { ws } = await seedCall({ settings: optOut })
		const [row] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(and(eq(workspaces.id, ws.id)))
		const parsed = workspaceSettingsSchema.partial().safeParse(row?.settings)
		expect(parsed.success).toBe(true)
		expect(parsed.success && parsed.data.voice).toEqual({ persist_transcripts: false })
	})
})
