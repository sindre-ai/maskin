import { capturePosthogEvent } from './posthog'

// Server-side PostHog emitter for the self-serve LinkedIn outreach bet's
// connect-half ship metric. The compound query counts distinct workspaces
// that fired BOTH `linkedin_account_connected` AND a customer-account
// message-sent event — this module owns the connect half; the send half
// is T3.
//
// `capturePosthogEvent` is best-effort and never throws — see `posthog.ts`.
// The caller is responsible for the fire-exactly-once guard (only invoke
// on a state transition from row-absent or `handoff` into `syncing`), so
// that a user reloading the callback URL within the state TTL doesn't
// double-count.

interface LinkedinAccountConnectedProps {
	workspaceId: string
	actorId: string
	unipileAccountId: string
}

export async function trackLinkedinAccountConnected(
	p: LinkedinAccountConnectedProps,
): Promise<void> {
	await capturePosthogEvent('linkedin_account_connected', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		unipile_account_id: p.unipileAccountId,
	})
}
