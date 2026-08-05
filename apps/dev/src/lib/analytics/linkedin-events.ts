import { capturePosthogEvent } from './posthog'

// Server-side PostHog emitters for the self-serve LinkedIn outreach bet's
// compound ship metric. The query counts distinct workspaces that fired BOTH
// `linkedin_account_connected` AND `linkedin_message_sent` (via a customer-
// connected account) within the review window.
//
// `capturePosthogEvent` is best-effort and never throws — see `posthog.ts`.
// Each emitter's fire-exactly-once guarantee lives at its call site:
//   - `trackLinkedinAccountConnected` — the callback only invokes on a state
//     transition from row-absent or `handoff` into `syncing`, so a redirect
//     replay within the state TTL doesn't double-count.
//   - `trackLinkedinMessageSent` — the send route invokes only inside the
//     success branch after Unipile returns 2xx, so a failed send never emits.
//     Client-level retry idempotency is enforced by the API's
//     `Idempotency-Key` middleware in front of the route.

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

interface LinkedinMessageSentProps {
	workspaceId: string
	actorId: string
	unipileAccountId: string
	chatId: string
	messageId: string
}

// This emitter is customer-account-only by construction — the send route it's
// called from loads the workspace's `linkedin_accounts` row, which is a
// customer-owned Unipile account by T1's schema. Any future internal-Maskin-
// account send path must use a distinct emitter so the compound ship metric
// stays clean. `via_customer_account: true` is hardcoded here for the same
// reason and to match the compound query in the bet's `metadata.posthog_query`
// verbatim.
export async function trackLinkedinMessageSent(p: LinkedinMessageSentProps): Promise<void> {
	await capturePosthogEvent('linkedin_message_sent', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		unipile_account_id: p.unipileAccountId,
		chat_id: p.chatId,
		message_id: p.messageId,
		via_customer_account: true,
	})
}
