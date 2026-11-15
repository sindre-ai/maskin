import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import type { Database } from '@maskin/db'
import {
	maybeTrackOnboardingResearchAnswered,
	maybeTrackOnboardingSecondMessage,
} from '../../../lib/analytics/onboarding-events'

/** A db whose every select resolves to the next queued row list, whatever the chain looks like. */
function fakeDb(...results: unknown[][]): Database {
	const queue = [...results]
	const chain = (): unknown => {
		const node: Record<string, unknown> = Promise.resolve(queue.shift() ?? []) as never
		for (const m of ['from', 'where', 'limit', 'innerJoin']) node[m] = () => node
		return node
	}
	return { select: () => chain() } as unknown as Database
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

const second = { workspaceId: 'ws-1', conversationId: 'conv-1', actorId: 'human-1' }

describe('maybeTrackOnboardingSecondMessage', () => {
	it('emits once, with ids only, when the second message lands in a sign-up chat', async () => {
		await maybeTrackOnboardingSecondMessage(fakeDb([{ id: 1 }], [{ value: 2 }]), second)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('onboarding_second_message', 'human-1', {
			workspace_id: 'ws-1',
			conversation_id: 'conv-1',
		})
	})

	it('stays quiet on the first and on the third message', async () => {
		await maybeTrackOnboardingSecondMessage(fakeDb([{ id: 1 }], [{ value: 1 }]), second)
		await maybeTrackOnboardingSecondMessage(fakeDb([{ id: 1 }], [{ value: 3 }]), second)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('stays quiet in a chat that did not start at sign-up', async () => {
		await maybeTrackOnboardingSecondMessage(fakeDb([], [{ value: 2 }]), second)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})

const answer = {
	workspaceId: 'ws-1',
	actorId: 'human-1',
	objectId: 'obj-1',
	parentEventId: 7,
	content: 'Looks right',
}
const card = [
	{ data: { decision: { options: [{ label: 'Looks right' }, { label: 'Wrong entirely' }] } } },
]
const signupObject = [{ metadata: { source: 'signup_capture' } }]

describe('maybeTrackOnboardingResearchAnswered', () => {
	it('emits the answer as one property when a person taps an option on the sign-up card', async () => {
		await maybeTrackOnboardingResearchAnswered(fakeDb(card, signupObject), answer)
		await maybeTrackOnboardingResearchAnswered(fakeDb(card, signupObject), {
			...answer,
			content: 'Wrong entirely',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(2)
		expect(capturePosthogEventMock.mock.calls[0]).toEqual([
			'onboarding_research_answered',
			'human-1',
			{ workspace_id: 'ws-1', answer: 'looks_right' },
		])
		expect(capturePosthogEventMock.mock.calls[1]?.[2]).toMatchObject({ answer: 'wrong' })
	})

	it('ignores text that is not one of the three answers, without reading the database', async () => {
		await maybeTrackOnboardingResearchAnswered(fakeDb(), { ...answer, content: 'Thanks, go ahead' })
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('ignores a reply that is not under a decision card with that option', async () => {
		await maybeTrackOnboardingResearchAnswered(
			fakeDb([{ data: { content: 'hi' } }], signupObject),
			answer,
		)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('ignores the same words on an object that is not the sign-up one', async () => {
		await maybeTrackOnboardingResearchAnswered(
			fakeDb(card, [{ metadata: { source: 'other' } }]),
			answer,
		)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
