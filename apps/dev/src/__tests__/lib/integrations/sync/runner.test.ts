import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackIntegrationSyncCompletedMock } = vi.hoisted(() => ({
	trackIntegrationSyncCompletedMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/integration-events', () => ({
	trackIntegrationSyncCompleted: trackIntegrationSyncCompletedMock,
}))

import { runIntegrationSync } from '../../../../lib/integrations/sync/runner'

beforeEach(() => {
	trackIntegrationSyncCompletedMock.mockClear()
	trackIntegrationSyncCompletedMock.mockResolvedValue(undefined)
})

describe('runIntegrationSync', () => {
	it('emits integration_sync_completed with success + records_written from the work outcome', async () => {
		const result = await runIntegrationSync(
			{ provider: 'google-search-console', workspaceId: 'ws-1', isBackfill: false },
			async () => ({ recordsWritten: 128 }),
		)

		expect(result).toEqual({ recordsWritten: 128 })
		expect(trackIntegrationSyncCompletedMock).toHaveBeenCalledOnce()
		expect(trackIntegrationSyncCompletedMock).toHaveBeenCalledWith({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			recordsWritten: 128,
			syncStatus: 'success',
			isBackfill: false,
		})
	})

	it('emits integration_sync_completed with error + records_written = 0 and re-throws when work throws', async () => {
		const boom = new Error('rate limited')

		await expect(
			runIntegrationSync(
				{ provider: 'google-search-console', workspaceId: 'ws-1', isBackfill: false },
				async () => {
					throw boom
				},
			),
		).rejects.toBe(boom)

		expect(trackIntegrationSyncCompletedMock).toHaveBeenCalledOnce()
		expect(trackIntegrationSyncCompletedMock).toHaveBeenCalledWith({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			recordsWritten: 0,
			syncStatus: 'error',
			isBackfill: false,
		})
	})

	it('flags the initial backfill run with is_backfill = true', async () => {
		await runIntegrationSync(
			{ provider: 'google-search-console', workspaceId: 'ws-1', isBackfill: true },
			async () => ({ recordsWritten: 20000 }),
		)

		expect(trackIntegrationSyncCompletedMock).toHaveBeenCalledWith(
			expect.objectContaining({ isBackfill: true, syncStatus: 'success' }),
		)
	})

	it('does not swallow the work outcome when the emit itself rejects', async () => {
		trackIntegrationSyncCompletedMock.mockRejectedValueOnce(new Error('posthog down'))

		const result = await runIntegrationSync(
			{ provider: 'google-search-console', workspaceId: 'ws-1', isBackfill: false },
			async () => ({ recordsWritten: 7 }),
		)

		expect(result).toEqual({ recordsWritten: 7 })
	})
})
