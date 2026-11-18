import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	YOUTUBE_ACTION_DECIDED,
	YOUTUBE_TOOL_CALLED,
	type YoutubeToolName,
	trackYoutubeActionDecided,
	trackYoutubeToolCalled,
	wholeHoursToDecide,
} from '../../../lib/analytics/youtube-events'

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackYoutubeToolCalled', () => {
	it('sends ids, the derived part number, a category and the loop flag, with the agent as distinct id', async () => {
		await trackYoutubeToolCalled({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			sessionId: 'sess-1',
			tool: 'get_analytics',
			outcome: 'ok',
			viaLoop: true,
		})
		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(YOUTUBE_TOOL_CALLED, 'agent-1', {
			workspace_id: 'ws-1',
			agent_id: 'agent-1',
			session_id: 'sess-1',
			tool: 'get_analytics',
			part: 3,
			outcome: 'ok',
			via_loop: true,
		})
	})

	it.each([
		['get_channel', 1],
		['search', 2],
		['get_analytics', 3],
		['post_comment', 4],
		['upload_video', 5],
	] as const)('maps %s to part %i', async (tool, part) => {
		await trackYoutubeToolCalled({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			sessionId: null,
			tool,
			outcome: 'quota_blocked',
			viaLoop: false,
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			YOUTUBE_TOOL_CALLED,
			'agent-1',
			expect.objectContaining({ part, session_id: null, via_loop: false }),
		)
	})

	it('drops a tool name it does not know instead of sending free text', async () => {
		await trackYoutubeToolCalled({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			sessionId: null,
			tool: 'My video title' as YoutubeToolName,
			outcome: 'ok',
			viaLoop: false,
		})
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('sends only scalar ids, counts, booleans and categories', async () => {
		await trackYoutubeToolCalled({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			sessionId: 'sess-1',
			tool: 'list_comments',
			outcome: 'upstream_error',
			viaLoop: false,
		})
		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(Object.keys(props).sort()).toEqual([
			'agent_id',
			'outcome',
			'part',
			'session_id',
			'tool',
			'via_loop',
			'workspace_id',
		])
	})

	it('swallows PostHog failures so a tool call never fails on analytics', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))
		await expect(
			trackYoutubeToolCalled({
				workspaceId: 'ws-1',
				agentId: 'agent-1',
				sessionId: null,
				tool: 'get_channel',
				outcome: 'ok',
				viaLoop: false,
			}),
		).resolves.toBeUndefined()
	})
})

describe('trackYoutubeActionDecided', () => {
	it('sends kind, decision and whole hours, with the deciding person as distinct id', async () => {
		await trackYoutubeActionDecided({
			workspaceId: 'ws-1',
			decidedBy: 'human-1',
			kind: 'post_comment',
			decision: 'approved',
			requestedAt: new Date('2026-11-18T08:00:00Z'),
			decidedAt: new Date('2026-11-18T11:59:59Z'),
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith(YOUTUBE_ACTION_DECIDED, 'human-1', {
			workspace_id: 'ws-1',
			kind: 'post_comment',
			decision: 'approved',
			hours_to_decide: 3,
		})
	})

	it('uses the workspace as distinct id when the action expired with no decider', async () => {
		await trackYoutubeActionDecided({
			workspaceId: 'ws-1',
			decidedBy: null,
			kind: 'upload_video',
			decision: 'expired',
			requestedAt: new Date('2026-11-01T00:00:00Z'),
			decidedAt: new Date('2026-11-08T00:00:00Z'),
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			YOUTUBE_ACTION_DECIDED,
			'ws-1',
			expect.objectContaining({ decision: 'expired', hours_to_decide: 168 }),
		)
	})

	it('swallows PostHog failures', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))
		await expect(
			trackYoutubeActionDecided({
				workspaceId: 'ws-1',
				decidedBy: 'human-1',
				kind: 'like',
				decision: 'rejected',
				requestedAt: new Date(),
				decidedAt: new Date(),
			}),
		).resolves.toBeUndefined()
	})
})

describe('wholeHoursToDecide', () => {
	it('rounds down and never goes below zero', () => {
		expect(
			wholeHoursToDecide(new Date('2026-11-18T10:00:00Z'), new Date('2026-11-18T10:59:00Z')),
		).toBe(0)
		expect(
			wholeHoursToDecide(new Date('2026-11-18T10:00:00Z'), new Date('2026-11-18T09:00:00Z')),
		).toBe(0)
	})
})
