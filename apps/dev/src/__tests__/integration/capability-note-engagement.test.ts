import { beforeEach, describe, expect, it } from 'vitest'
import { readNoteEngagement } from '../../lib/capabilities/note-engagement'
import { recordEvent } from '../../lib/events/record-event'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The Product Validator reads replies and opens from the events table, not
// PostHog. A reply is a later message_posted by the person; an open is a
// read-state update by the person whose last_read_message_id reaches the note.
describe('readNoteEngagement (integration)', () => {
	let workspaceId: string
	let personId: string
	let otherPersonId: string
	let agentId: string
	let conversationId: string
	let otherConversationId: string

	const NOTE_MESSAGE_ID = 100

	async function posted(actorId: string, messageId: number, conversation = conversationId) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'message_posted',
			entityType: 'conversation',
			entityId: conversation,
			data: { message_id: messageId, author_actor_id: actorId },
		})
	}

	async function readState(
		actorId: string,
		data: Record<string, unknown>,
		conversation = conversationId,
	) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'conversation_participant_state_updated',
			entityType: 'conversation',
			entityId: conversation,
			data,
		})
	}

	beforeEach(async () => {
		personId = getTestActorId()
		const ws = await insertWorkspace(db, personId)
		workspaceId = ws.id
		otherPersonId = (await insertActor(db, { type: 'human', name: 'Someone Else' })).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' })).id
		conversationId = (await insertConversation(db, workspaceId, personId)).id
		otherConversationId = (await insertConversation(db, workspaceId, personId)).id
	})

	it('returns the later replies and the opens at or past the note, and nothing else', async () => {
		// The note itself is authored by the agent.
		await posted(agentId, NOTE_MESSAGE_ID)
		// Person: one message before the note (not a reply), two after.
		await posted(personId, 99)
		await posted(personId, 101)
		await posted(personId, 104)
		// Someone else replying in the same conversation does not count.
		await posted(otherPersonId, 102)
		// A reply in a different conversation does not count.
		await posted(personId, 103, otherConversationId)
		// Read state: before the note, exactly at the note, past the note.
		await readState(personId, { last_read_message_id: 99 })
		await readState(personId, { last_read_message_id: NOTE_MESSAGE_ID })
		await readState(personId, { last_read_message_id: 105 })
		// A pin toggle carries no last_read_message_id and is not an open.
		await readState(personId, { pinned: true })
		// Another person's read state, and another conversation's, do not count.
		await readState(otherPersonId, { last_read_message_id: 110 })
		await readState(personId, { last_read_message_id: 110 }, otherConversationId)

		const engagement = await readNoteEngagement(db, {
			workspaceId,
			conversationId,
			noteMessageId: NOTE_MESSAGE_ID,
			personId,
		})

		expect(engagement.replies.map((r) => r.messageId)).toEqual([101, 104])
		expect(engagement.opens.map((o) => o.lastReadMessageId)).toEqual([NOTE_MESSAGE_ID, 105])
	})

	it('returns empty lists when the person has not replied or opened', async () => {
		await posted(agentId, NOTE_MESSAGE_ID)
		const engagement = await readNoteEngagement(db, {
			workspaceId,
			conversationId,
			noteMessageId: NOTE_MESSAGE_ID,
			personId,
		})
		expect(engagement).toEqual({ replies: [], opens: [] })
	})
})
