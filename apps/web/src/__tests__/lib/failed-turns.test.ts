import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'
import { dropRedoneFailedTurns, supersededFailedReplyIds } from '@/lib/failed-turns'
import { describe, expect, it } from 'vitest'

function message(
	id: number,
	overrides: Partial<MessageResponse> & { triggerId?: number; failed?: boolean } = {},
): MessageResponse {
	const { triggerId, failed, ...rest } = overrides
	return {
		id,
		conversationId: 'c1',
		actorId: 'agent-1',
		actorName: 'Agent',
		actorType: 'agent',
		kind: 'message',
		content: 'reply',
		metadata:
			triggerId === undefined
				? null
				: {
						source: 'final_output',
						final_output: {
							dedupe_key: `k${id}`,
							message_id: triggerId,
							...(failed ? { is_error: true, error_kind: 'permanent' as const } : {}),
						},
					},
		sessionId: null,
		createdAt: null,
		editedAt: null,
		...rest,
	} as MessageResponse
}

const human = message(1, { actorId: 'human-1', actorType: 'human', content: 'hi' })

describe('supersededFailedReplyIds', () => {
	it('keeps a failed reply nobody has redone', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		expect(supersededFailedReplyIds(messages, new Set()).size).toBe(0)
	})

	it('hides the failed reply of a message the person just redid', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		expect([...supersededFailedReplyIds(messages, new Set([1]))]).toEqual([2])
	})

	it('hides the failed reply once the same agent has answered the same message again', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { triggerId: 1 }),
		]
		expect([...supersededFailedReplyIds(messages, new Set())]).toEqual([2])
	})

	it('shows only the newest failure when the redo failed too', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { triggerId: 1, failed: true }),
		]
		expect([...supersededFailedReplyIds(messages, new Set())]).toEqual([2])
	})

	it('leaves another agent’s failed reply to the same message alone', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { actorId: 'agent-2', triggerId: 1 }),
		]
		expect(supersededFailedReplyIds(messages, new Set()).size).toBe(0)
	})

	it('never hides a successful reply, redone or not', () => {
		const messages = [human, message(2, { triggerId: 1 })]
		expect(supersededFailedReplyIds(messages, new Set([1, 2])).size).toBe(0)
	})

	it('hides a failed reply that is redone with its own Retry button', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		expect([...supersededFailedReplyIds(messages, new Set([2]))]).toEqual([2])
	})
})

describe('dropRedoneFailedTurns', () => {
	const failedTurn = {
		sessionId: 's1',
		actorId: 'agent-1',
		steps: [],
		inProgress: false,
		failed: true,
	}
	const liveTurn = { sessionId: 's2', actorId: 'agent-1', steps: [], inProgress: true }
	const turns = [failedTurn, liveTurn] as MessageTurnActivity[]

	it('drops the failed session pill under a redone message and keeps the live turn', () => {
		expect(dropRedoneFailedTurns(turns, 1, new Set([1]))).toEqual([liveTurn])
	})

	it('leaves every turn alone when the message was not redone', () => {
		expect(dropRedoneFailedTurns(turns, 1, new Set())).toBe(turns)
	})
})
