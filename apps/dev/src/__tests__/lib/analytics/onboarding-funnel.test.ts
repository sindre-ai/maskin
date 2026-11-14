import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackFlowStepMock, trackFlowErrorMock, startedByPersonMock } = vi.hoisted(() => ({
	trackFlowStepMock: vi.fn().mockResolvedValue(undefined),
	trackFlowErrorMock: vi.fn().mockResolvedValue(undefined),
	startedByPersonMock: vi.fn(),
}))
vi.mock('../../../lib/analytics/flow-events', () => ({
	trackFlowStep: trackFlowStepMock,
	trackFlowError: trackFlowErrorMock,
}))
vi.mock('../../../lib/session-access', () => ({ startedByPerson: startedByPersonMock }))

import {
	firstRunErrorCategory,
	trackFirstRunSettled,
	trackFirstRunStarted,
	trackIntroReply,
	trackOnboardingStep,
} from '../../../lib/analytics/onboarding-funnel'

// A db whose select chain resolves to the queued rows, one array per query.
function dbWith(...rows: unknown[][]) {
	const queue = [...rows]
	const chain: Record<string, unknown> = {}
	for (const m of ['from', 'where', 'innerJoin', 'orderBy']) chain[m] = () => chain
	chain.limit = () => Promise.resolve(queue.shift() ?? [])
	return { select: () => chain } as never
}

const session = {
	id: 'sess-1',
	workspaceId: 'ws-1',
	createdBy: 'human-1',
	triggerId: null,
	conversationId: 'conv-1',
	createdAt: new Date('2026-11-13T10:00:00Z'),
}

beforeEach(() => {
	trackFlowStepMock.mockClear()
	trackFlowErrorMock.mockClear()
	startedByPersonMock.mockReset()
	startedByPersonMock.mockResolvedValue(true)
})

describe('trackOnboardingStep', () => {
	it('sends the step on the person id, which is also the flow id', async () => {
		await trackOnboardingStep({ workspaceId: 'ws-1', humanId: 'human-1', step: 'workspace_ready' })
		expect(trackFlowStepMock).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			actorId: 'human-1',
			flow: 'signup_to_first_result',
			step: 'workspace_ready',
			flowId: 'human-1',
			detail: undefined,
		})
	})
})

describe('trackFirstRunStarted', () => {
	it('sends first_run_started when no earlier chat run exists', async () => {
		await trackFirstRunStarted(dbWith([]), session)
		expect(trackFlowStepMock).toHaveBeenCalledWith(
			expect.objectContaining({ step: 'first_run_started', actorId: 'human-1' }),
		)
	})

	it('sends nothing when the person already had a chat run', async () => {
		await trackFirstRunStarted(dbWith([{ id: 'older' }]), session)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})

	it('sends nothing for a run no person started', async () => {
		startedByPersonMock.mockResolvedValue(false)
		await trackFirstRunStarted(dbWith([]), session)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})

	it('sends nothing for a run with no chat, such as the welcome session', async () => {
		await trackFirstRunStarted(dbWith([]), { ...session, conversationId: null })
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})
})

describe('trackFirstRunSettled', () => {
	it('sends first_run_completed when the first run completed', async () => {
		await trackFirstRunSettled(dbWith([session], []), 'sess-1', 'completed', undefined)
		expect(trackFlowStepMock).toHaveBeenCalledWith(
			expect.objectContaining({ step: 'first_run_completed', actorId: 'human-1' }),
		)
	})

	it('sends flow_error with missing_model_key when the run could not start without a key', async () => {
		await trackFirstRunSettled(dbWith([session], []), 'sess-1', 'failed', 'not_logged_in')
		expect(trackFlowErrorMock).toHaveBeenCalledWith(
			expect.objectContaining({
				step: 'first_run_completed',
				flowId: 'human-1',
				errorCategory: 'missing_model_key',
			}),
		)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})

	it('sends nothing for a stop or a pause', async () => {
		await trackFirstRunSettled(dbWith([session], []), 'sess-1', 'user_stopped', undefined)
		await trackFirstRunSettled(dbWith([session], []), 'sess-1', 'paused', undefined)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
		expect(trackFlowErrorMock).not.toHaveBeenCalled()
	})

	it('sends nothing when it was not the first run', async () => {
		await trackFirstRunSettled(
			dbWith([session], [{ id: 'older' }]),
			'sess-1',
			'completed',
			undefined,
		)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})
})

describe('firstRunErrorCategory', () => {
	it('maps the reason code and outcome to a fixed category', () => {
		expect(firstRunErrorCategory({ reasonCode: 'not_logged_in', outcome: 'failed' })).toBe(
			'missing_model_key',
		)
		expect(firstRunErrorCategory({ reasonCode: undefined, outcome: 'timeout' })).toBe('timeout')
		expect(firstRunErrorCategory({ reasonCode: 'something_else', outcome: 'failed' })).toBe(
			'unknown',
		)
	})
})

describe('trackIntroReply', () => {
	const args = {
		workspaceId: 'ws-1',
		conversationId: 'conv-1',
		humanId: 'human-1',
		messageId: 7,
		tappedStepIndex: null as number | null,
	}
	const introOpening = [{ metadata: { delivery: { kind: 'agent_intro' } } }]

	it('sends intro_clicked as typed for the first human message under an intro', async () => {
		await trackIntroReply(dbWith([{ id: 7 }], introOpening), args)
		expect(trackFlowStepMock).toHaveBeenCalledWith(
			expect.objectContaining({ step: 'intro_clicked', detail: { via: 'typed' } }),
		)
	})

	it('sends intro_clicked as a button with the step index when a send step was tapped', async () => {
		await trackIntroReply(dbWith([{ id: 7 }], introOpening), { ...args, tappedStepIndex: 2 })
		expect(trackFlowStepMock).toHaveBeenCalledWith(
			expect.objectContaining({ detail: { via: 'button', step_index: 2 } }),
		)
	})

	it('sends nothing when an earlier human message exists', async () => {
		await trackIntroReply(dbWith([{ id: 3 }], introOpening), args)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})

	it('sends nothing when the chat does not open with an intro', async () => {
		await trackIntroReply(dbWith([{ id: 7 }], [{ metadata: null }]), args)
		expect(trackFlowStepMock).not.toHaveBeenCalled()
	})
})
