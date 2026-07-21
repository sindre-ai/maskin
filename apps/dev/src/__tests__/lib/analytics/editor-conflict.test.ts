import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	EDITOR_WRITE_CONFLICT_DETECTED,
	capturePosthogEditorWriteConflictDetected,
} from '../../../lib/analytics/editor-conflict'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('capturePosthogEditorWriteConflictDetected', () => {
	it('exports the canonical event name so callers cannot fat-finger it', () => {
		expect(EDITOR_WRITE_CONFLICT_DETECTED).toBe('editor_write_conflict_detected')
	})

	it('emits the guardrail event with the ship-metric payload shape for a PATCH conflict', async () => {
		await capturePosthogEditorWriteConflictDetected({
			objectId: 'obj-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			source: 'patch',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'editor_write_conflict_detected',
			'actor-1',
			{
				object_id: 'obj-1',
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				source: 'patch',
			},
		)
	})

	it('threads `source: mcp` through so the analyst can split by write path', async () => {
		await capturePosthogEditorWriteConflictDetected({
			objectId: 'obj-2',
			workspaceId: 'ws-2',
			actorId: 'actor-2',
			source: 'mcp',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'editor_write_conflict_detected',
			'actor-2',
			expect.objectContaining({ source: 'mcp' }),
		)
	})

	it('keys the distinct_id on actor_id so PostHog person-level joins line up with the rest of the taxonomy', async () => {
		await capturePosthogEditorWriteConflictDetected({
			objectId: 'obj-4',
			workspaceId: 'ws-4',
			actorId: 'actor-4',
			source: 'patch',
		})

		const [, distinctId] = capturePosthogEventMock.mock.calls[0] ?? []
		expect(distinctId).toBe('actor-4')
	})
})
