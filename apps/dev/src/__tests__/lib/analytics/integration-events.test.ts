import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	INTEGRATION_CONNECTED,
	INTEGRATION_SYNC_COMPLETED,
	trackIntegrationConnected,
	trackIntegrationSyncCompleted,
} from '../../../lib/analytics/integration-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackIntegrationConnected', () => {
	it('captures the framework event with provider + workspace_id + auth_type + is_backfill', async () => {
		await trackIntegrationConnected({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			authType: 'oauth',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(INTEGRATION_CONNECTED, 'ws-1', {
			provider: 'google-search-console',
			workspace_id: 'ws-1',
			auth_type: 'oauth',
			is_backfill: false,
		})
	})

	it('exports the canonical event-name constant', () => {
		expect(INTEGRATION_CONNECTED).toBe('integration_connected')
	})

	it('carries the auth_type through for api_key providers', async () => {
		await trackIntegrationConnected({
			provider: 'posthog',
			workspaceId: 'ws-1',
			authType: 'api_key',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_CONNECTED,
			'ws-1',
			expect.objectContaining({ auth_type: 'api_key' }),
		)
	})

	it('carries the auth_type through for manual providers', async () => {
		await trackIntegrationConnected({
			provider: 'skjald',
			workspaceId: 'ws-1',
			authType: 'manual',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_CONNECTED,
			'ws-1',
			expect.objectContaining({ auth_type: 'manual' }),
		)
	})
})

describe('trackIntegrationSyncCompleted', () => {
	it('captures success with records_written, sync_status, and is_backfill on the payload', async () => {
		await trackIntegrationSyncCompleted({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			recordsWritten: 42,
			syncStatus: 'success',
			isBackfill: false,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(INTEGRATION_SYNC_COMPLETED, 'ws-1', {
			provider: 'google-search-console',
			workspace_id: 'ws-1',
			records_written: 42,
			sync_status: 'success',
			is_backfill: false,
		})
	})

	it('captures error runs with records_written = 0 and sync_status = error', async () => {
		await trackIntegrationSyncCompleted({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			recordsWritten: 0,
			syncStatus: 'error',
			isBackfill: false,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_SYNC_COMPLETED,
			'ws-1',
			expect.objectContaining({ records_written: 0, sync_status: 'error' }),
		)
	})

	it('flags the initial backfill run with is_backfill = true', async () => {
		await trackIntegrationSyncCompleted({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			recordsWritten: 12000,
			syncStatus: 'success',
			isBackfill: true,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_SYNC_COMPLETED,
			'ws-1',
			expect.objectContaining({ is_backfill: true }),
		)
	})

	it('exports the canonical event-name constant', () => {
		expect(INTEGRATION_SYNC_COMPLETED).toBe('integration_sync_completed')
	})
})
