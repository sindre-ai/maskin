import { describe, expect, it, vi } from 'vitest'
import {
	CLOSING_NOTES_SYSTEM,
	callWarrantsNotes,
	formatCallTranscript,
	writeClosingNotes,
} from '../../services/live-closing-notes'
import { createTestContext } from '../setup'

vi.mock('../../services/conversation-messages', () => ({
	insertConversationMessage: vi.fn(async () => ({ id: 77 })),
}))
vi.mock('../../services/live-transcript', () => ({
	isLiveTranscriptEnabled: vi.fn(async () => true),
}))

const { insertConversationMessage } = await import('../../services/conversation-messages')
const { isLiveTranscriptEnabled } = await import('../../services/live-transcript')

const session = {
	id: 's1',
	workspaceId: 'w1',
	agentActorId: 'agent',
	conversationId: 'c1',
	inputMode: 'audio',
} as never

const call = [
	{ actorId: 'h', actorName: 'Sebastian', content: 'What is blocked?' },
	{ actorId: 'agent', actorName: 'CoS', content: 'Two bets wait on legal.' },
	{ actorId: 'h', actorName: 'Sebastian', content: 'Chase legal today.' },
]

describe('call transcript', () => {
	it('labels the agent as You and everyone else by name', () => {
		expect(formatCallTranscript(call, 'agent')).toBe(
			'Sebastian: What is blocked?\nYou: Two bets wait on legal.\nSebastian: Chase legal today.',
		)
	})
	it('only warrants notes after two spoken turns from the person', () => {
		expect(callWarrantsNotes(call, 'agent')).toBe(true)
		expect(callWarrantsNotes(call.slice(0, 2), 'agent')).toBe(false)
	})
	it('tells the model to answer NONE when there is nothing to note', () => {
		expect(CLOSING_NOTES_SYSTEM).toMatch(/NONE/)
		expect(CLOSING_NOTES_SYSTEM).toMatch(/never ids/)
	})
})

describe('writeClosingNotes', () => {
	function ctxWith(lines: unknown[]) {
		const ctx = createTestContext()
		ctx.mockResults.selectQueue = [lines]
		return ctx
	}

	it('posts the model notes as the agent in the same conversation', async () => {
		vi.mocked(insertConversationMessage).mockClear()
		const { db } = ctxWith(call)
		const r = await writeClosingNotes({ db, session, complete: async () => '- Chase legal today.' })
		expect(r).toEqual({ messageId: 77 })
		expect(insertConversationMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				conversationId: 'c1',
				actorId: 'agent',
				content: '- Chase legal today.',
			}),
		)
	})

	it('writes nothing for a short call, for NONE, or for an empty answer', async () => {
		vi.mocked(insertConversationMessage).mockClear()
		const short = ctxWith(call.slice(0, 2))
		expect(await writeClosingNotes({ db: short.db, session, complete: async () => 'x' })).toBeNull()
		const none = ctxWith(call)
		expect(
			await writeClosingNotes({ db: none.db, session, complete: async () => 'NONE' }),
		).toBeNull()
		const empty = ctxWith(call)
		expect(
			await writeClosingNotes({ db: empty.db, session, complete: async () => '  ' }),
		).toBeNull()
		expect(insertConversationMessage).not.toHaveBeenCalled()
	})

	it('respects the transcript opt-out and a call with no conversation', async () => {
		vi.mocked(isLiveTranscriptEnabled).mockResolvedValueOnce(false)
		const a = ctxWith(call)
		expect(await writeClosingNotes({ db: a.db, session, complete: async () => 'x' })).toBeNull()
		const b = ctxWith(call)
		expect(
			await writeClosingNotes({
				db: b.db,
				session: { ...(session as object), conversationId: null } as never,
				complete: async () => 'x',
			}),
		).toBeNull()
	})

	it('swallows a model failure instead of throwing', async () => {
		const { db } = ctxWith(call)
		await expect(
			writeClosingNotes({
				db,
				session,
				complete: async () => {
					throw new Error('boom')
				},
			}),
		).resolves.toBeNull()
	})
})
