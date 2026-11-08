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
export const INTEGRATION_TOOL_CALLED = 'integration_tool_called'

// Auth path that produced the connect event. `oauth` covers both standard
// oauth2 providers (the callback route) and `oauth2_custom` (GitHub App),
// since Product Validator's success check only distinguishes at the
// provider granularity.
export type IntegrationAuthType = 'oauth' | 'api_key' | 'manual'

export type SyncStatus = 'success' | 'error'

export interface IntegrationConnectedProps {
	provider: string
	workspaceId: string
	actorId: string
	integrationId: string
	// Optional so the provider-specific connect route (linkedin-unipile), which
	// already emits this event, keeps compiling unchanged. The shared routes in
	// routes/integrations.ts always set it.
	authType?: IntegrationAuthType
	// `is_backfill` is on both events per Product Validator's refinement so
	// PostHog queries can filter the same way on either. A connect never is a
	// backfill in itself — the initial 16-month backfill runs from the sync
	// loop that follows — so this defaults to `false`, kept for schema
	// symmetry with `integration_sync_completed`.
	isBackfill?: boolean
}

/**
 * Fire `integration_connected` on successful integration credential landing.
 *
 * The bet's Signals Scout section names this as the observable half of the
 * "connect + send" win criterion — without it, a successful connect and a
 * successful send collapse into a single downstream `mcp_tool_call_response_size`
 * signal and we can't tell which half worked. Distinct id is the actor (the
 * connecting human), matching the actor-scoped credential model.
 *
 * Best-effort per capturePosthogEvent — never throws.
 */
export async function trackIntegrationConnected(p: IntegrationConnectedProps): Promise<void> {
	await capturePosthogEvent(INTEGRATION_CONNECTED, p.actorId, {
		provider: p.provider,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		integration_id: p.integrationId,
		...(p.authType ? { auth_type: p.authType } : {}),
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

export interface IntegrationToolCalledProps {
	provider: string
	tool: string
	outcome: 'success' | 'error'
	errorCode: string | null
	actorId: string
	sessionId: string | null
	workspaceId: string
}

/**
 * One event per call to a tool on a Maskin-hosted integration MCP (first user: Deepdots). It
 * measures use and success of the connection: which tools agents call, and whether the call
 * worked.
 *
 * Privacy contract: the properties below are the whole payload. Never the arguments, search
 * text, answer rows or error text; those can hold customer feedback. integration-events.test.ts
 * asserts the exact key set, so adding a property fails that test on purpose.
 *
 * Best-effort per capturePosthogEvent: never throws.
 */
export async function trackIntegrationToolCalled(p: IntegrationToolCalledProps): Promise<void> {
	await capturePosthogEvent(INTEGRATION_TOOL_CALLED, p.actorId, {
		provider: p.provider,
		tool: p.tool,
		outcome: p.outcome,
		error_code: p.errorCode,
		actor_id: p.actorId,
		session_id: p.sessionId,
		workspace_id: p.workspaceId,
	})
}
