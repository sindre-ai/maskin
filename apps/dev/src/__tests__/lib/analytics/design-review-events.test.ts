import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	INTERACTION_ISSUE_CATEGORIES,
	isInteractionIssueCategory,
	trackDesignReviewInteractionIssueFlagged,
} from '../../../lib/analytics/design-review-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('isInteractionIssueCategory', () => {
	it('accepts every category in the contracted enum', () => {
		for (const category of INTERACTION_ISSUE_CATEGORIES) {
			expect(isInteractionIssueCategory(category)).toBe(true)
		}
	})

	it('rejects strings outside the enum', () => {
		expect(isInteractionIssueCategory('click')).toBe(false)
		expect(isInteractionIssueCategory('')).toBe(false)
		expect(isInteractionIssueCategory('DRAG')).toBe(false)
	})

	it('rejects non-string values', () => {
		expect(isInteractionIssueCategory(undefined)).toBe(false)
		expect(isInteractionIssueCategory(null)).toBe(false)
		expect(isInteractionIssueCategory(0)).toBe(false)
		expect(isInteractionIssueCategory(['drag'])).toBe(false)
	})
})

describe('trackDesignReviewInteractionIssueFlagged', () => {
	it('emits the contracted event with workspace_id as distinct id', async () => {
		await trackDesignReviewInteractionIssueFlagged({
			workspaceId: 'ws-1',
			taskId: 'task-1',
			designAgentRunId: 'run-7',
			issueCategory: 'drag',
			reviewerActorId: 'actor-1',
			prototypeArtifactUrl: '/api/files/file-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'design_review_interaction_issue_flagged',
			'ws-1',
			{
				task_id: 'task-1',
				design_agent_run_id: 'run-7',
				issue_category: 'drag',
				reviewer_actor_id: 'actor-1',
				prototype_artifact_url: '/api/files/file-1',
			},
		)
	})

	it('passes through null run id and null artifact url unchanged', async () => {
		await trackDesignReviewInteractionIssueFlagged({
			workspaceId: 'ws-1',
			taskId: 'task-1',
			designAgentRunId: null,
			issueCategory: 'other',
			reviewerActorId: 'actor-1',
			prototypeArtifactUrl: null,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'design_review_interaction_issue_flagged',
			'ws-1',
			expect.objectContaining({
				design_agent_run_id: null,
				prototype_artifact_url: null,
				issue_category: 'other',
			}),
		)
	})
})
