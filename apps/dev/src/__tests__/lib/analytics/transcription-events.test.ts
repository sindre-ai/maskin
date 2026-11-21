import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue('sent'),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackTranscriptionCompleted } from '../../../lib/analytics/transcription-events'

describe('trackTranscriptionCompleted', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
	})

	it('sends one event with workspace, source, cost and audio seconds', async () => {
		await trackTranscriptionCompleted({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			source: 'mcp_file',
			model: 'mistralai/voxtral-small-transcribe-3-0',
			costUsd: 0.0123,
			audioSeconds: 42.5,
			fileId: 'file-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('transcription_completed', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			source: 'mcp_file',
			model: 'mistralai/voxtral-small-transcribe-3-0',
			cost_usd: 0.0123,
			audio_seconds: 42.5,
			file_id: 'file-1',
		})
	})

	it('sends a null file id for chat dictation', async () => {
		await trackTranscriptionCompleted({
			workspaceId: 'ws-2',
			actorId: 'actor-2',
			source: 'chat_dictation',
			model: 'mistralai/voxtral-small-transcribe-3-0',
			costUsd: 0,
			audioSeconds: 3,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'transcription_completed',
			'ws-2',
			expect.objectContaining({ file_id: null, source: 'chat_dictation' }),
		)
	})
})
