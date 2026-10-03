import { createPrivateKey, createPublicKey, sign } from 'node:crypto'

/**
 * Throwaway Ed25519 key for the Telnyx webhook specs, built from a fixed seed.
 * It signs nothing but test traffic. **playwright.config.ts** injects
 * E2E_TELNYX_PUBLIC_KEY into the dev webServer as TELNYX_PUBLIC_KEY, so the
 * server verifies exactly what these specs sign. Like E2E_AGENT_SERVER_SECRET,
 * this only applies when Playwright spawns the server: with reuseExistingServer
 * the server keeps whatever key it was started with.
 */
const SEED = Buffer.from('a1a2a3a4a5a6a7a8a9aaabacadaeaf00b1b2b3b4b5b6b7b8b9babbbcbdbebf01', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const privateKey = createPrivateKey({
	key: Buffer.concat([PKCS8_PREFIX, SEED]),
	format: 'der',
	type: 'pkcs8',
})

/** base64 of the raw 32-byte public key, the format TELNYX_PUBLIC_KEY uses. */
export const E2E_TELNYX_PUBLIC_KEY = createPublicKey(privateKey)
	.export({ format: 'der', type: 'spki' })
	.subarray(-32)
	.toString('base64')

const WEBHOOK_URL = 'http://localhost:3000/api/integrations/telnyx/webhook'

export function telnyxSignature(rawBody: string, timestamp: string): string {
	return sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64')
}

export function telnyxEvent(
	eventType: string,
	payload: Record<string, unknown>,
	id = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
) {
	return { data: { event_type: eventType, id, occurred_at: new Date().toISOString(), payload } }
}

export function clientState(state: {
	contact_id: string
	workspace_id: string
	dial_attempt_n: number
}): string {
	return Buffer.from(JSON.stringify(state)).toString('base64')
}

export interface PostWebhookOptions {
	/** Seconds added to now for the telnyx-timestamp header. */
	timestampOffsetSeconds?: number
	/** Override the signature (e.g. a bad one). */
	signature?: string
	/** Send no signature headers at all. */
	unsigned?: boolean
}

export async function postTelnyxWebhook(
	body: unknown,
	opts: PostWebhookOptions = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const raw = JSON.stringify(body)
	const timestamp = String(Math.floor(Date.now() / 1000) + (opts.timestampOffsetSeconds ?? 0))
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (!opts.unsigned) {
		headers['telnyx-timestamp'] = timestamp
		headers['telnyx-signature-ed25519'] = opts.signature ?? telnyxSignature(raw, timestamp)
	}
	const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body: raw })
	const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
	return { status: res.status, json }
}

/**
 * Port of the stub Telnyx REST server the effects spec runs. playwright.config.ts
 * points the dev webServer's TELNYX_API_BASE_URL at it, so the reducer's SMS and
 * forced-hangup calls land somewhere a spec can read them.
 */
export const E2E_TELNYX_STUB_PORT = 4599
export const E2E_TELNYX_STUB_URL = `http://127.0.0.1:${E2E_TELNYX_STUB_PORT}`

/**
 * Port of the stub PostHog ingestion server **voice-posthog-events.spec.ts**
 * runs. playwright.config.ts points the dev webServer's POSTHOG_HOST at it (with
 * a throwaway POSTHOG_API_KEY, which the server needs before it captures at all),
 * so the voice events the call path emits land somewhere a spec can read them.
 */
export const E2E_POSTHOG_STUB_PORT = 4598
export const E2E_POSTHOG_STUB_URL = `http://127.0.0.1:${E2E_POSTHOG_STUB_PORT}`
