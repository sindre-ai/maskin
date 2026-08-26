import { capturePosthogEvent } from './posthog'

// Framework-level PostHog events for third-party integrations. Both fire from
// the shared code path (this file + `lib/integrations/sync/runner.ts`) so
// every provider — GSC, GA, Ads, and anything filed against the same catalog
// later — inherits them without provider-specific instrumentation.
//
// Constants exist so downstream queries, alerts, and Product Validator's
// weekly checks can't drift out of sync with the emit sites.
export const INTEGRATION_CONNECTED = 'integration_connected'
export const INTEGRATION_SYNC_COMPLETED = 'integration_sync_completed'

// Auth path that produced the connect event. `oauth` covers both standard
// oauth2 providers (the callback route) and `oauth2_custom` (GitHub App),
// since Product Validator's success check only distinguishes at the
// provider granularity.
export type IntegrationAuthType = 'oauth' | 'api_key' | 'manual'

export type SyncStatus = 'success' | 'error'

interface IntegrationConnectedProps {
	provider: string
	workspaceId: string
	authType: IntegrationAuthType
	// `is_backfill` is on both events per Product Validator's refinement so
	// PostHog queries can filter the same way on either. A connect never is a
	// backfill in itself — the initial 16-month backfill runs from the sync
	// loop that follows — so this is always `false` here, kept for schema
	// symmetry with `integration_sync_completed`.
	isBackfill?: boolean
}

export async function trackIntegrationConnected(p: IntegrationConnectedProps): Promise<void> {
	await capturePosthogEvent(INTEGRATION_CONNECTED, p.workspaceId, {
		provider: p.provider,
		workspace_id: p.workspaceId,
		auth_type: p.authType,
		is_backfill: p.isBackfill ?? false,
	})
}

interface IntegrationSyncCompletedProps {
	provider: string
	workspaceId: string
	recordsWritten: number
	syncStatus: SyncStatus
	// True for the initial post-connect backfill run, false for every daily
	// delta append that follows. Providers decide which they are running when
	// they wrap their sync with `runIntegrationSync`.
	isBackfill: boolean
}

export async function trackIntegrationSyncCompleted(
	p: IntegrationSyncCompletedProps,
): Promise<void> {
	await capturePosthogEvent(INTEGRATION_SYNC_COMPLETED, p.workspaceId, {
		provider: p.provider,
		workspace_id: p.workspaceId,
		records_written: p.recordsWritten,
		sync_status: p.syncStatus,
		is_backfill: p.isBackfill,
	})
}
