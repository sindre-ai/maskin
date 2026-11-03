import { describe, expect, it } from 'vitest'
import { config } from '../../../../../lib/integrations/providers/resend/config'
import { getProvider, listProviders } from '../../../../../lib/integrations/registry'

// The frontend MCP preset lives in `apps/web` and cannot be imported directly
// from this backend suite (different tsconfig, different alias). Inlining the
// expected shape here — verbatim from `INTEGRATION_MCP_PRESETS.resend` in
// `apps/web/src/components/agents/mcp-servers.tsx` — is what actually stops
// silent drift between the two: any change on either side must be reflected on
// both, or this assertion fails. Analogue of the posthog double-write guard at
// `apps/dev/src/__tests__/lib/integrations/providers/posthog.test.ts:33`.
const FRONTEND_INTEGRATION_MCP_PRESET_RESEND = {
	type: 'http',
	url: 'https://mcp.resend.com/mcp',
	headers: { Authorization: 'Bearer ${RESEND_API_KEY}' },
}

describe('Resend provider config', () => {
	it('has correct name, display name, and description', () => {
		expect(config.name).toBe('resend')
		expect(config.displayName).toBe('Resend')
		expect(config.description).toBe(
			'Bring your own Resend account — agents send and receive on your verified domain',
		)
	})

	it("uses 'manual' auth so the customer-owned API key rides /connect → /complete", () => {
		// Spec §3: `api_key` is for env-configured Maskin-side secrets
		// (`envKeyName` on `ApiKeyConfig`); Resend's key belongs to the customer
		// and is unique per install. With `manual`, TokenManager falls through to
		// the standard-OAuth2 branch and returns `credentials.accessToken` as-is
		// (no expiresAt on manual credentials).
		expect(config.auth.type).toBe('manual')
	})

	it('declares only the resend.email/received event definition', () => {
		expect(config.events?.definitions).toEqual([
			{ entityType: 'resend.email', actions: ['received'], label: 'Email' },
		])
	})

	it('has no webhook config — dedicated /resend/:token route handles Svix verify per-row', () => {
		// Spec §4: the generic single-secret verifier in webhooks/handler.ts can't
		// reach a per-integration Svix secret; Resend's dedicated route in Task 3
		// does the work.
		expect(config.webhook).toBeUndefined()
	})

	it('declares autoInject so session-manager wires the MCP for every workspace with an active integration', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.autoInject).toBe(true)
		expect(config.mcp?.envKey).toBe('RESEND_API_KEY')
	})

	it('declares an HTTP server spec matching the frontend INTEGRATION_MCP_PRESETS.resend entry byte-for-byte', () => {
		// Double-write drift guard. Any change to either the config here or the
		// frontend preset in `apps/web/src/components/agents/mcp-servers.tsx`
		// without touching the other fails this test — spec §3 + §12.6.
		expect(config.mcp?.server).toEqual(FRONTEND_INTEGRATION_MCP_PRESET_RESEND)
	})

	it('is discoverable via getProvider and listed by listProviders', () => {
		const resolved = getProvider('resend')
		expect(resolved).toBeTruthy()
		expect(resolved.config.name).toBe('resend')
		expect(listProviders().some((p) => p.config.name === 'resend')).toBe(true)
	})

	it('carries none of the ResolvedProvider hooks that belong to the dedicated /resend/:token route (Task 3)', () => {
		// Spec §12.3: if anyone later "migrates" resend to the /:provider catch-all
		// thinking it will simplify, they will silently lose dedup because there's
		// no extractDeliveryId on this provider entry — the dedicated route reads
		// data.email_id inline. Assert the current shape so a future edit can't
		// smuggle a hook in without a matching route-ordering audit.
		const resolved = getProvider('resend')
		expect(resolved.customWebhookVerifier).toBeUndefined()
		expect(resolved.customNormalizer).toBeUndefined()
		expect(resolved.webhookFanOut).toBeUndefined()
		expect(resolved.postInstall).toBeUndefined()
		expect(resolved.preDisconnect).toBeUndefined()
		expect(resolved.extractDeliveryId).toBeUndefined()
	})
})
