import type { ProviderConfig } from '../../types'

/**
 * Telnyx voice provider (bet/5b8e-voice-outreach).
 *
 * Workspace-scoped: deliberately NOT in `actorScopedProviders`
 * (lib/integrations/lookup.ts), so one connection serves the whole workspace.
 * The API key rides the generic integration credential store, which is
 * encrypted at rest with INTEGRATION_ENCRYPTION_KEY.
 *
 * No `webhook` block and no `mcp` block: Telnyx posts to the dedicated route
 * routes/integrations-telnyx-webhook.ts (Ed25519, not the generic HMAC path),
 * and the voice agent never sees a raw Telnyx credential.
 */
export const config: ProviderConfig = {
	name: 'telnyx',
	displayName: 'Telnyx',
	description: 'Outbound AI voice calls, SMS and call events for cold-outreach campaigns',
	category: 'voice',
	scope: 'workspace',

	auth: {
		type: 'api_key',
		config: {
			headerName: 'Authorization',
			headerPrefix: 'Bearer ',
			envKeyName: 'TELNYX_API_KEY',
		},
	},
}

export const DEFAULT_CALL_RATE_LIMIT_PER_MINUTE = 5
// Week-1 pilot cap locked by the sponsor. Flip to 500 by changing the env value.
export const DEFAULT_CALL_DAILY_CAP = 200

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === '') return fallback
	const n = Number(raw)
	return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback
}

export interface TelnyxRuntimeConfig {
	apiKey: string | null
	/** Base64 (raw 32-byte or SPKI DER) Ed25519 public key used to verify webhooks. */
	publicKey: string | null
	appId: string | null
	assistantId: string | null
	/** Telnyx REST origin. Overridable so E2E can point the client at a stub. */
	apiBaseUrl: string
	callRateLimitPerMinute: number
	callDailyCap: number
}

/**
 * Reads the Telnyx env surface. Read on every call (cheap) so tests and an
 * env flip + restart behave the same; the public key is cached separately by
 * the signature verifier.
 */
export function readTelnyxRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TelnyxRuntimeConfig {
	const str = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)
	return {
		apiKey: str(env.TELNYX_API_KEY),
		publicKey: str(env.TELNYX_PUBLIC_KEY),
		appId: str(env.TELNYX_APP_ID),
		assistantId: str(env.TELNYX_ASSISTANT_ID),
		apiBaseUrl: str(env.TELNYX_API_BASE_URL) ?? 'https://api.telnyx.com',
		callRateLimitPerMinute: positiveInt(
			env.CALL_RATE_LIMIT_PER_MINUTE,
			DEFAULT_CALL_RATE_LIMIT_PER_MINUTE,
		),
		callDailyCap: positiveInt(env.CALL_DAILY_CAP, DEFAULT_CALL_DAILY_CAP),
	}
}
