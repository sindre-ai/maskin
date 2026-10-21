import { randomUUID } from 'node:crypto'
import { conversationParticipants } from '@maskin/db/schema'
import { resolveHumanBehindSession } from '../../services/session-origin'
import {
	insertActor,
	insertConversation,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

// resolveHumanBehindSession walks real session rows (own chat, who started it,
// who spawned it) and reads chat participants, so it runs against real Postgres.
// The table is the 15 cases of the intro-always-to-a-human addendum, section 3.7.

type Actor = { id: string }

describe('resolveHumanBehindSession', () => {
	let workspaceId: string
	let human: Actor
	let otherHuman: Actor
	let chiefOfStaff: Actor
	let builder: Actor

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		human = await insertActor(db, { type: 'human' })
		otherHuman = await insertActor(db, { type: 'human' })
		chiefOfStaff = await insertActor(db, { type: 'agent' })
		builder = await insertActor(db, { type: 'agent' })
	})

	async function chat(active: Actor[], left: Actor[] = []): Promise<{ id: string }> {
		const conversation = await insertConversation(db, workspaceId, human.id)
		await db.insert(conversationParticipants).values([
			...active.map((a) => ({ conversationId: conversation.id, actorId: a.id })),
			...left.map((a) => ({
				conversationId: conversation.id,
				actorId: a.id,
				leftAt: new Date(),
			})),
		])
		return conversation
	}

	function session(actor: Actor, createdBy: Actor, overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, actor.id, createdBy.id, overrides)
	}

	function resolve(claimed: { id: string } | null, creator: Actor) {
		return resolveHumanBehindSession(db, {
			claimedSessionId: claimed?.id ?? null,
			creatorId: creator.id,
			workspaceId,
		})
	}

	it('walks chat session, helper and sub-helper to the human', async () => {
		const conversation = await chat([human, chiefOfStaff])
		const chatSession = await session(chiefOfStaff, human, { conversationId: conversation.id })
		const helper = await session(builder, chiefOfStaff, { spawnedBySessionId: chatSession.id })
		const subHelper = await session(builder, builder, { spawnedBySessionId: helper.id })

		expect(await resolve(subHelper, builder)).toEqual({
			ok: true,
			humanId: human.id,
			via: 'chat',
			hops: 2,
		})
	})

	describe('cases', () => {
		it('human creator: a session a person started directly resolves to that person', async () => {
			const started = await session(chiefOfStaff, human)

			expect(await resolve(started, chiefOfStaff)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'person_started',
				hops: 0,
			})
		})

		it('chat session in a 1-1 resolves to the human in the chat', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const started = await session(chiefOfStaff, human, { conversationId: conversation.id })

			expect(await resolve(started, chiefOfStaff)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('chat session in a group resolves to the author when they are a participant', async () => {
			const conversation = await chat([human, otherHuman, chiefOfStaff])
			const started = await session(chiefOfStaff, otherHuman, {
				conversationId: conversation.id,
			})

			expect(await resolve(started, chiefOfStaff)).toEqual({
				ok: true,
				humanId: otherHuman.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('chat session in a group where the author left resolves to the single remaining human', async () => {
			const conversation = await chat([human, chiefOfStaff], [otherHuman])
			const started = await session(chiefOfStaff, otherHuman, {
				conversationId: conversation.id,
			})

			expect(await resolve(started, chiefOfStaff)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('skips a group chat where the author left and two humans remain', async () => {
			const third = await insertActor(db, { type: 'human' })
			const conversation = await chat([human, third, chiefOfStaff], [otherHuman])
			const started = await session(chiefOfStaff, otherHuman, {
				conversationId: conversation.id,
			})

			expect(await resolve(started, chiefOfStaff)).toEqual({
				ok: false,
				reason: 'origin_group_chat',
			})
		})

		it('helper of a chat session (1 hop) resolves to the human in that chat', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const chatSession = await session(chiefOfStaff, human, { conversationId: conversation.id })
			const helper = await session(builder, chiefOfStaff, { spawnedBySessionId: chatSession.id })

			expect(await resolve(helper, builder)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 1,
			})
		})

		it('helper of helper (3 hops) resolves to the human at the end of the chain', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const chatSession = await session(chiefOfStaff, human, { conversationId: conversation.id })
			const h1 = await session(builder, chiefOfStaff, { spawnedBySessionId: chatSession.id })
			const h2 = await session(builder, builder, { spawnedBySessionId: h1.id })
			const h3 = await session(builder, builder, { spawnedBySessionId: h2.id })

			expect(await resolve(h3, builder)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 3,
			})
		})

		it('mention session by a human resolves to the commenter with no walk', async () => {
			const mention = await session(chiefOfStaff, human, {
				config: { trigger_source: 'comment_fallback' },
			})

			expect(await resolve(mention, chiefOfStaff)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'person_started',
				hops: 0,
			})
		})

		it('mention session by an agent with a link to a chat session resolves through the chat', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const chatSession = await session(chiefOfStaff, human, { conversationId: conversation.id })
			const mention = await session(builder, chiefOfStaff, {
				config: { trigger_source: 'comment_fallback' },
				spawnedBySessionId: chatSession.id,
			})

			expect(await resolve(mention, builder)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 1,
			})
		})

		it('cron session whose trigger a human created still resolves to no human', async () => {
			const trigger = await insertTrigger(db, workspaceId, human.id, chiefOfStaff.id, {
				type: 'cron',
				config: { cron: '0 9 * * *' },
			})
			const cron = await session(chiefOfStaff, human, { triggerId: trigger.id })

			expect(await resolve(cron, chiefOfStaff)).toEqual({
				ok: false,
				reason: 'unattended_origin',
			})
		})

		it('gives no_session when there is no header', async () => {
			expect(await resolve(null, chiefOfStaff)).toEqual({ ok: false, reason: 'no_session' })
		})

		it('gives session_claim_invalid for the header of another actor', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const theirs = await session(chiefOfStaff, human, { conversationId: conversation.id })

			expect(await resolve(theirs, builder)).toEqual({
				ok: false,
				reason: 'session_claim_invalid',
			})
		})

		it('gives session_claim_invalid for a header naming a session in another workspace', async () => {
			const otherWorkspace = await insertWorkspace(db, getTestActorId())
			const elsewhere = await insertSession(db, otherWorkspace.id, chiefOfStaff.id, human.id)

			expect(await resolve(elsewhere, chiefOfStaff)).toEqual({
				ok: false,
				reason: 'session_claim_invalid',
			})
		})

		it('gives session_claim_invalid for a header naming a session that does not exist', async () => {
			expect(await resolve({ id: randomUUID() }, chiefOfStaff)).toEqual({
				ok: false,
				reason: 'session_claim_invalid',
			})
		})

		it('treats a finished claimed session of the same actor as still valid', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const finished = await session(chiefOfStaff, human, {
				conversationId: conversation.id,
				status: 'completed',
			})

			expect(await resolve(finished, chiefOfStaff)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('falls back to ask_conversation_id when the parent row was purged', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const orphan = await session(builder, chiefOfStaff, {
				spawnedBySessionId: randomUUID(),
				config: { ask_conversation_id: conversation.id },
			})

			expect(await resolve(orphan, builder)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('falls back to origin_conversation_id when the link was dropped', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const helper = await session(builder, chiefOfStaff, {
				config: { origin_conversation_id: conversation.id },
			})

			expect(await resolve(helper, builder)).toEqual({
				ok: true,
				humanId: human.id,
				via: 'chat',
				hops: 0,
			})
		})

		it('stops a chain of 5 at 4 nodes, so the chat behind the 5th is not reached', async () => {
			const conversation = await chat([human, chiefOfStaff])
			const chatSession = await session(chiefOfStaff, human, { conversationId: conversation.id })
			const h1 = await session(builder, chiefOfStaff, { spawnedBySessionId: chatSession.id })
			const h2 = await session(builder, builder, { spawnedBySessionId: h1.id })
			const h3 = await session(builder, builder, { spawnedBySessionId: h2.id })
			const h4 = await session(builder, builder, { spawnedBySessionId: h3.id })

			expect(await resolve(h4, builder)).toEqual({ ok: false, reason: 'unattended_origin' })
		})
	})
})
