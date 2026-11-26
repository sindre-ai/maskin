import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	CHAT_SESSION_ROTATED_EVENT,
	trackChatSessionRotated,
} from '../../../lib/analytics/chat-session-events'

beforeEach(() => capturePosthogEventMock.mockClear())

describe('trackChatSessionRotated', () => {
	it('sends the six properties and nothing else', async () => {
		await trackChatSessionRotated({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			reason: 'size',
			route: 'maskin_plan',
			sizeBucket: '150k_200k',
			handoff: 'ok',
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith(CHAT_SESSION_ROTATED_EVENT, 'agent-1', {
			reason: 'size',
			route: 'maskin_plan',
			agent_id: 'agent-1',
			workspace_id: 'ws-1',
			size_bucket: '150k_200k',
			handoff: 'ok',
		})
	})

	it('never throws when the send fails', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('down'))
		await expect(
			trackChatSessionRotated({
				workspaceId: 'ws-1',
				agentId: 'agent-1',
				reason: 'compaction_failed',
				route: null,
				sizeBucket: 'unknown',
				handoff: 'fallback',
			}),
		).resolves.toBeUndefined()
	})
})
