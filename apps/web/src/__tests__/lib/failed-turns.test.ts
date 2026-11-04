import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'
import {
	type RedoneTurns,
	dropRedoneFailedTurns,
	redoKey,
	snapshotRedo,
	supersededFailedReplyIds,
} from '@/lib/failed-turns'
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

const failedTurn = {
	sessionId: 's1',
	actorId: 'agent-1',
	steps: [],
	inProgress: false,
	failed: true,
}
const liveTurn = { sessionId: 's2', actorId: 'agent-1', steps: [], inProgress: true }

const human = message(1, { actorId: 'human-1', actorType: 'human', content: 'hi' })

/** A redo of message 1, pressed when the thread held messages up to `upToMessageId`. */
function redoOf(upToMessageId: number, failedSessionIds: string[] = []): RedoneTurns {
	return new Map([[1, { upToMessageId, failedSessionIds: new Set(failedSessionIds) }]])
}

describe('supersededFailedReplyIds', () => {
	it('keeps a failed reply nobody has redone', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		expect(supersededFailedReplyIds(messages, new Map()).size).toBe(0)
	})

	it('hides the failed reply of a message the person just redid', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		expect([...supersededFailedReplyIds(messages, redoOf(2))]).toEqual([2])
	})

	it('keeps a new failure after a redo that failed again', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { triggerId: 1, failed: true }),
		]
		expect([...supersededFailedReplyIds(messages, redoOf(2))]).toEqual([2])
	})

	it('hides the failed reply once the same agent has answered the same message again', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { triggerId: 1 }),
		]
		expect([...supersededFailedReplyIds(messages, new Map())]).toEqual([2])
	})

	it('shows only the newest failure after a reload when the redo failed too', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { triggerId: 1, failed: true }),
		]
		expect([...supersededFailedReplyIds(messages, new Map())]).toEqual([2])
	})

	it('leaves another agent’s failed reply to the same message alone', () => {
		const messages = [
			human,
			message(2, { triggerId: 1, failed: true }),
			message(3, { actorId: 'agent-2', triggerId: 1 }),
		]
		expect(supersededFailedReplyIds(messages, new Map()).size).toBe(0)
	})

	it('never hides a successful reply, redone or not', () => {
		const messages = [human, message(2, { triggerId: 1 })]
		expect(supersededFailedReplyIds(messages, redoOf(2)).size).toBe(0)
	})

	it('hides a failed reply that is redone with its own Retry button', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		// Retry on the agent reply stores the redo under the message the reply answered.
		expect(redoKey(messages[1])).toBe(1)
		expect([...supersededFailedReplyIds(messages, redoOf(2))]).toEqual([2])
	})
})

describe('snapshotRedo', () => {
	it('records the newest message and the failed sessions at redo time', () => {
		const messages = [human, message(2, { triggerId: 1, failed: true })]
		const snapshot = snapshotRedo(messages, [
			{ ...failedTurn, sessionId: 's1' },
			{ ...liveTurn, sessionId: 's2' },
		] as MessageTurnActivity[])
		expect(snapshot.upToMessageId).toBe(2)
		expect([...snapshot.failedSessionIds]).toEqual(['s1'])
	})
})

describe('dropRedoneFailedTurns', () => {
	const turns = [failedTurn, liveTurn] as MessageTurnActivity[]

	it('drops the failed session pill under a redone message and keeps the live turn', () => {
		expect(dropRedoneFailedTurns(turns, 1, redoOf(2, ['s1']))).toEqual([liveTurn])
	})

	it('keeps a failed session that started after the redo', () => {
		const newFailure = { ...failedTurn, sessionId: 's3' } as MessageTurnActivity
		const result = dropRedoneFailedTurns(
			[failedTurn, newFailure] as MessageTurnActivity[],
			1,
			redoOf(2, ['s1']),
		)
		expect(result).toEqual([newFailure])
	})

	it('leaves every turn alone when the message was not redone', () => {
		expect(dropRedoneFailedTurns(turns, 1, new Map())).toBe(turns)
	})
})
