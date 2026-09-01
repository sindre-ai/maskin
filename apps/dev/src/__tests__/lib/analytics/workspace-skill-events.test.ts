import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	WORKSPACE_SKILL_ATTACHED,
	WORKSPACE_SKILL_LOADED,
	trackWorkspaceSkillAttached,
	trackWorkspaceSkillLoaded,
} from '../../../lib/analytics/workspace-skill-events'

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackWorkspaceSkillAttached', () => {
	it('emits the brief-specified props with workspace as distinct_id', async () => {
		await trackWorkspaceSkillAttached({
			workspaceId: 'ws-1',
			actorId: 'human-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			via: 'ui',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(WORKSPACE_SKILL_ATTACHED, 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'human-1',
			agent_actor_id: 'agent-1',
			skill_name: 'pr-review',
			via: 'ui',
		})
	})

	it('includes skill_visible when the caller supplies it', async () => {
		await trackWorkspaceSkillAttached({
			workspaceId: 'ws-1',
			actorId: 'human-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			via: 'ui',
			skillVisible: false,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			WORKSPACE_SKILL_ATTACHED,
			'ws-1',
			expect.objectContaining({ skill_visible: false }),
		)
	})

	it('omits skill_visible when the caller does not supply it', async () => {
		await trackWorkspaceSkillAttached({
			workspaceId: 'ws-1',
			actorId: 'human-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			via: 'ui',
		})

		const props = capturePosthogEventMock.mock.calls[0][2] as Record<string, unknown>
		expect(props).not.toHaveProperty('skill_visible')
	})

	it('propagates via=mcp', async () => {
		await trackWorkspaceSkillAttached({
			workspaceId: 'ws-1',
			actorId: 'human-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			via: 'mcp',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			WORKSPACE_SKILL_ATTACHED,
			'ws-1',
			expect.objectContaining({ via: 'mcp' }),
		)
	})

	it('swallows PostHog failures — attach must never fail because analytics tripped', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackWorkspaceSkillAttached({
				workspaceId: 'ws-1',
				actorId: 'human-1',
				agentActorId: 'agent-1',
				skillName: 'pr-review',
				via: 'ui',
			}),
		).resolves.toBeUndefined()
	})
})

describe('trackWorkspaceSkillLoaded', () => {
	it('emits the brief-specified props including session_id', async () => {
		await trackWorkspaceSkillLoaded({
			workspaceId: 'ws-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			sessionId: 'sess-42',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(WORKSPACE_SKILL_LOADED, 'ws-1', {
			workspace_id: 'ws-1',
			agent_actor_id: 'agent-1',
			skill_name: 'pr-review',
			session_id: 'sess-42',
		})
	})

	it('accepts a null sessionId (pull happened outside a session context)', async () => {
		await trackWorkspaceSkillLoaded({
			workspaceId: 'ws-1',
			agentActorId: 'agent-1',
			skillName: 'pr-review',
			sessionId: null,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			WORKSPACE_SKILL_LOADED,
			'ws-1',
			expect.objectContaining({ session_id: null }),
		)
	})

	it('swallows PostHog failures — session-hydration must not fail because analytics tripped', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackWorkspaceSkillLoaded({
				workspaceId: 'ws-1',
				agentActorId: 'agent-1',
				skillName: 'pr-review',
				sessionId: 'sess-42',
			}),
		).resolves.toBeUndefined()
	})
})
