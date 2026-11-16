import {
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { vi } from 'vitest'
import {
	computerHandbackForCard,
	computerHandbackForMessage,
} from '../../services/computer-handback'
import { deliverTurnToAgent } from '../../services/conversation-responder'
import type { WorkspaceDesktopService } from '../../services/workspace-desktop'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The screenshot a person's Done on a computer card sends the agent. Against real Postgres for
 * the card lookup (which message, whose, which kind); the computer itself is a stand-in.
 */

// The computer deliverTurnToAgent reaches for by itself: a stand-in.
const desktop = vi.hoisted(() => ({ control: vi.fn() }))
vi.mock('../../services/workspace-desktop', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/workspace-desktop')>()),
	createWorkspaceDesktopService: () => ({ control: desktop.control }),
}))

const screenshot = (control: WorkspaceDesktopService['control']) =>
	({ control }) as unknown as WorkspaceDesktopService

const shot = {
	status: 200,
	body: { image_base64: 'QUJD', mime_type: 'image/jpeg', width: 1920, height: 1080 },
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	const other = await insertActor(db, { type: 'agent' })
	for (const a of [agent, other]) {
		await db.insert(workspaceMembers).values({ workspaceId: ws.id, actorId: a.id, role: 'member' })
	}
	const [chat] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Chat', createdBy: human })
		.returning()
	await db.insert(conversationParticipants).values({ conversationId: chat.id, actorId: human })
	const card = async (actorId: string, metadata: Record<string, unknown>) =>
		(
			await db
				.insert(messages)
				.values({ conversationId: chat.id, actorId, content: 'Card', kind: 'message', metadata })
				.returning()
		)[0]
	const done = async (cardId: number, outcome: 'done' | 'declined' = 'done') =>
		(
			await db
				.insert(messages)
				.values({
					conversationId: chat.id,
					actorId: human,
					content: 'Done.',
					kind: 'message',
					metadata: { hidden_from_chat: true, card_answer: { message_id: cardId, outcome } },
				})
				.returning()
		)[0]
	const computerCard = (actorId: string) =>
		card(actorId, { computer_request: { session_id: 'x', task: 'Approve the prompt.' } })
	return { human, ws, agent, other, chat, card, done, computerCard }
}

describe('computerHandbackForCard (Integration)', () => {
	it('attaches the screenshot taken now when the agent that asked gets its Done', async () => {
		const s = await setup()
		const cardMsg = await s.computerCard(s.agent.id)
		const control = vi.fn(async () => shot)

		const handback = await computerHandbackForCard(db, {
			workspaceId: s.ws.id,
			conversationId: s.chat.id,
			cardMessageId: cardMsg.id,
			agentId: s.agent.id,
			desktopService: screenshot(control as never),
		})

		expect(control).toHaveBeenCalledWith(s.ws.id, s.agent.id, 'screenshot', {}, expect.any(Number))
		expect(handback?.images).toEqual([{ mediaType: 'image/jpeg', data: 'QUJD' }])
		expect(handback?.note).toContain('screenshot of your computer, taken just now')
	})

	it.each([
		['the computer does not answer', async () => null],
		['the computer answers with an error', async () => ({ status: 502, body: { error: 'x' } })],
		['the computer sends no image', async () => ({ status: 200, body: {} })],
		[
			'the call throws',
			async () => {
				throw new Error('boom')
			},
		],
	])('tells the agent in plain words, with no image, when %s', async (_name, control) => {
		const s = await setup()
		const cardMsg = await s.computerCard(s.agent.id)

		const handback = await computerHandbackForCard(db, {
			workspaceId: s.ws.id,
			conversationId: s.chat.id,
			cardMessageId: cardMsg.id,
			agentId: s.agent.id,
			desktopService: screenshot(control as never),
		})

		expect(handback?.images).toEqual([])
		expect(handback?.note).toContain('could not take a screenshot of your computer just now')
		expect(handback?.note).toContain('desktop_screenshot')
	})

	it('does nothing for another agent, another kind of card, or a card in another chat', async () => {
		const s = await setup()
		const control = vi.fn(async () => shot)
		const args = {
			workspaceId: s.ws.id,
			conversationId: s.chat.id,
			agentId: s.agent.id,
			desktopService: screenshot(control as never),
		}
		const theirs = await s.computerCard(s.other.id)
		const keychain = await s.card(s.agent.id, { keychain_request: { kind: 'api_key' } })
		const mine = await s.computerCard(s.agent.id)
		const [elsewhere] = await db
			.insert(conversations)
			.values({ workspaceId: s.ws.id, title: 'Elsewhere', createdBy: s.human })
			.returning()

		expect(await computerHandbackForCard(db, { ...args, cardMessageId: theirs.id })).toBeNull()
		expect(await computerHandbackForCard(db, { ...args, cardMessageId: keychain.id })).toBeNull()
		expect(
			await computerHandbackForCard(db, {
				...args,
				conversationId: elsewhere.id,
				cardMessageId: mine.id,
			}),
		).toBeNull()
		expect(control).not.toHaveBeenCalled()
	})
})

describe('computerHandbackForMessage (Integration)', () => {
	it('acts on the hidden Done message, not on a Not now or a plain message', async () => {
		const s = await setup()
		const cardMsg = await s.computerCard(s.agent.id)
		const control = vi.fn(async () => shot)
		const args = {
			workspaceId: s.ws.id,
			conversationId: s.chat.id,
			agentId: s.agent.id,
			desktopService: screenshot(control as never),
		}

		const declined = await s.done(cardMsg.id, 'declined')
		const plain = await s.card(s.human, {})
		expect(await computerHandbackForMessage(db, { ...args, messageId: declined.id })).toBeNull()
		expect(await computerHandbackForMessage(db, { ...args, messageId: plain.id })).toBeNull()
		expect(control).not.toHaveBeenCalled()

		const done = await s.done(cardMsg.id)
		const handback = await computerHandbackForMessage(db, { ...args, messageId: done.id })
		expect(handback?.images).toHaveLength(1)
		expect(control).toHaveBeenCalledTimes(1)
	})
})

describe('the turn a chat Done gives a running agent session (Integration)', () => {
	async function deliver(messageId: number, s: Awaited<ReturnType<typeof setup>>) {
		const writeInput = vi.fn(async () => {})
		const sessionManager = {
			findConversationSessionAnyActive: vi.fn(async () => ({
				id: 'session-1',
				status: 'running',
				workspaceId: s.ws.id,
			})),
			writeInput,
		}
		const outcome = await deliverTurnToAgent({
			db,
			sessionManager: sessionManager as never,
			workspaceId: s.ws.id,
			conversationId: s.chat.id,
			messageId,
			agentId: s.agent.id,
			message: {
				actorId: s.human,
				content: 'Done: I finished on the computer.',
				authorName: 'Person',
				authorType: 'human',
			},
			conversationHistory: [],
			isDirectConversation: true,
			wakeReason: 'legacy',
		})
		expect(outcome).toBe('wrote_to_running_session')
		// writeInput(sessionId, payload, attachments, messageId, logTags, images)
		const call = writeInput.mock.calls[0] as unknown as [
			string,
			{ message: { content: string } },
			unknown,
			number,
			unknown,
			unknown,
		]
		return { text: call[1].message.content, images: call[5] }
	}

	it('starts with a screenshot of the computer taken when Done was pressed', async () => {
		desktop.control.mockReset().mockResolvedValue(shot)
		const s = await setup()
		const done = await s.done((await s.computerCard(s.agent.id)).id)

		const turn = await deliver(done.id, s)

		expect(turn.text).toContain('Done: I finished on the computer.')
		expect(turn.text).toContain('screenshot of your computer, taken just now')
		expect(turn.images).toEqual([{ mediaType: 'image/jpeg', data: 'QUJD' }])
	})

	it('still wakes the agent, and says no screenshot could be taken, when the computer fails', async () => {
		desktop.control.mockReset().mockRejectedValue(new Error('asleep'))
		const s = await setup()
		const done = await s.done((await s.computerCard(s.agent.id)).id)

		const turn = await deliver(done.id, s)

		expect(turn.text).toContain('Done: I finished on the computer.')
		expect(turn.text).toContain('could not take a screenshot of your computer just now')
		expect(turn.images).toEqual([])
	})

	it('leaves an ordinary message alone: no screenshot, no extra text, no images', async () => {
		desktop.control.mockReset()
		const s = await setup()
		const plain = await s.card(s.human, {})

		const turn = await deliver(plain.id, s)

		expect(desktop.control).not.toHaveBeenCalled()
		expect(turn.text).not.toContain('screenshot')
		expect(turn.images).toBeUndefined()
	})
})
