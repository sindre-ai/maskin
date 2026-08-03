import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackAgentCommentPosted } from '../../../lib/analytics/comment-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackAgentCommentPosted', () => {
	it('emits agent_comment_posted with the actor as distinct id and the contracted props', async () => {
		await trackAgentCommentPosted({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'obj-1',
			entityType: 'object',
			content: 'Hey Sebk, quick question about the schema.',
			hasTaskList: false,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('agent_comment_posted', 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			entity_id: 'obj-1',
			entity_type: 'object',
			char_count: 42,
			has_visual: false,
			has_task_list: false,
			content: 'Hey Sebk, quick question about the schema.',
		})
	})

	it('emits the full verbatim content — no truncation, no substitution', async () => {
		// The bet's measurement gate depends on being able to grep prose in
		// HogQL (`lower(properties.content) LIKE '%sebastian%'`). If the emit
		// path ever hashes, truncates below COMMENT_MAX_LENGTH, or rewrites
		// the string, that gate fails silently. Lock the invariant.
		const body = 'Hi Sebastian — following up on the design review. See attached spec.'
		await trackAgentCommentPosted({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'obj-1',
			entityType: 'object',
			content: body,
			hasTaskList: false,
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.content).toBe(body)
	})

	it('flags visual fence and task-list channels independently of content', async () => {
		await trackAgentCommentPosted({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			entityId: 'obj-1',
			entityType: 'object',
			content: '```chart\ntype: line\n```',
			hasTaskList: true,
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.has_visual).toBe(true)
		expect(props.has_task_list).toBe(true)
		expect(props.content).toBe('```chart\ntype: line\n```')
	})
})
