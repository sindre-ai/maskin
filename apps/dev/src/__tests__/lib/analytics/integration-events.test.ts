import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	INTEGRATION_CONNECTED,
	INTEGRATION_CONNECT_STARTED,
	INTEGRATION_SYNC_COMPLETED,
	INTEGRATION_TOOL_CALLED,
	trackIntegrationConnectStarted,
	trackIntegrationConnected,
	trackIntegrationSyncCompleted,
	trackIntegrationToolCalled,
} from '../../../lib/analytics/integration-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackIntegrationConnected', () => {
	it('captures the framework event keyed on the actor with provider, workspace_id, ids, auth_type and is_backfill', async () => {
		await trackIntegrationConnected({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			integrationId: 'int-1',
			authType: 'oauth',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(INTEGRATION_CONNECTED, 'actor-1', {
			provider: 'google-search-console',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			integration_id: 'int-1',
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
			actorId: 'actor-1',
			integrationId: 'int-1',
			authType: 'api_key',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_CONNECTED,
			'actor-1',
			expect.objectContaining({ auth_type: 'api_key' }),
		)
	})

	it('carries the auth_type through for manual providers', async () => {
		await trackIntegrationConnected({
			provider: 'skjald',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			integrationId: 'int-1',
			authType: 'manual',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			INTEGRATION_CONNECTED,
			'actor-1',
			expect.objectContaining({ auth_type: 'manual' }),
		)
	})

	it('omits auth_type for provider-specific routes that do not pass one', async () => {
		await trackIntegrationConnected({
			provider: 'linkedin-unipile',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			integrationId: 'int-1',
		})

		const props = capturePosthogEventMock.mock.calls[0][2]
		expect(props).not.toHaveProperty('auth_type')
		expect(props).toMatchObject({ is_backfill: false })
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

describe('trackIntegrationConnectStarted', () => {
	it('captures the start of a sign-in with ids and provider only', async () => {
		await trackIntegrationConnectStarted({
			provider: 'notion',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(INTEGRATION_CONNECT_STARTED, 'actor-1', {
			provider: 'notion',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			auth_type: 'oauth',
		})
		expect(INTEGRATION_CONNECT_STARTED).toBe('integration_connect_started')
	})
})

describe('trackIntegrationToolCalled', () => {
	it('captures one call with the tool name, kind and outcome, and nothing from the arguments', async () => {
		await trackIntegrationToolCalled({
			provider: 'notion',
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			integrationId: 'int-1',
			toolName: 'notion-search',
			kind: 'read',
			ok: true,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(INTEGRATION_TOOL_CALLED, 'agent-1', {
			provider: 'notion',
			workspace_id: 'ws-1',
			actor_id: 'agent-1',
			integration_id: 'int-1',
			tool_name: 'notion-search',
			kind: 'read',
			ok: true,
		})
		expect(INTEGRATION_TOOL_CALLED).toBe('integration_tool_called')
	})
})
