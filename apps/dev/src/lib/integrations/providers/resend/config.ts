import type { ProviderConfig } from '../../types'

/**
 * Resend is a bring-your-own integration: each workspace connects its own
 * Resend account and verifies its own domain, and agents send + receive on the
 * customer's verified domain (bet cf2bcc85). `auth.type: 'manual'` because the
 * API key is customer-owned and rides the `/connect` → `/complete` handshake
 * rather than an env-configured Maskin-side secret; TokenManager reads
 * `credentials.accessToken` verbatim on the manual branch (see spec §3 and
 * `apps/dev/src/lib/integrations/oauth/token-manager.ts:82`).
 *
 * No `webhook` field on purpose. The generic single-secret verifier in
 * webhooks/handler.ts can't reach a per-integration Svix secret — Resend
 * deliveries go through a dedicated `webhookApp.post('/resend/:token', ...)`
 * route (Task 3) which looks up the per-row webhook secret and runs Svix
 * verification inline. `extractDeliveryId` is likewise not registered here —
 * the dedicated route reads `data.email_id` directly for dedup. If anyone
 * later "migrates" resend to the `/:provider` catch-all thinking it will
 * simplify, they will silently lose dedup because there's no
 * `extractDeliveryId` on this provider entry. Same reasoning applies to
 * `customWebhookVerifier` / `customNormalizer` / `webhookFanOut` / `postInstall`
 * / `preDisconnect` — the dedicated route does all the work (see spec §12.3).
 */
export const config: ProviderConfig = {
	name: 'resend',
	displayName: 'Resend',
	description: 'Bring your own Resend account — agents send and receive on your verified domain',

	auth: {
		type: 'manual',
	},

	events: {
		definitions: [
			{
				entityType: 'resend.email',
				actions: ['received'],
				label: 'Email',
			},
		],
	},

	// Per-workspace credential resolution on the send path. session-manager
	// filters `integrations` on `(workspaceId, status='active')`, TokenManager
	// returns `credentials.accessToken` verbatim for `auth.type='manual'`, and
	// `envVars.RESEND_API_KEY` is stamped into the session (see spec §3). The
	// literal `${RESEND_API_KEY}` in the Authorization header is expanded by
	// envsubst inside the container at CMD time — same pattern as PostHog
	// (`Bearer ${POSTHOG_TOKEN}`). Must match INTEGRATION_MCP_PRESETS.resend in
	// `apps/web/src/components/agents/mcp-servers.tsx` byte-for-byte; the
	// config.test.ts double-write assertion is what stops silent drift.
	mcp: {
		envKey: 'RESEND_API_KEY',
		autoInject: true,
		server: {
			type: 'http',
			url: 'https://mcp.resend.com/mcp',
			headers: { Authorization: 'Bearer ${RESEND_API_KEY}' },
		},
	},
}
