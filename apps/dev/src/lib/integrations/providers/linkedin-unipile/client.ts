import { createHmac, timingSafeEqual } from 'node:crypto'
import { UnipileUnavailableError } from './errors'

/**
 * Thin HTTP client for Unipile's REST API. Only the surface this task
 * actually calls is implemented — Task 3 hydrates send-message / list-chats /
 * reply, and the error taxonomy mapping (see errors.ts) lands there too.
 *
 * Configuration is read lazily so the module is safe to import in tests
 * that stand up their own env; each call resolves UNIPILE_BASE_URL and
 * UNIPILE_API_KEY at request time.
 */

export interface UnipileClientConfig {
	baseUrl: string
	apiKey: string
}

function resolveConfig(overrides?: Partial<UnipileClientConfig>): UnipileClientConfig {
	const baseUrl = (overrides?.baseUrl ?? process.env.UNIPILE_BASE_URL ?? '').replace(/\/$/, '')
	const apiKey = overrides?.apiKey ?? process.env.UNIPILE_API_KEY ?? ''
	if (!baseUrl) throw new Error('UNIPILE_BASE_URL is required')
	if (!apiKey) throw new Error('UNIPILE_API_KEY is required')
	return { baseUrl, apiKey }
}

export interface HostedAuthLinkRequest {
	/** Round-trip identifier — the maskin integrations row id. Unipile echoes this back on the callback. */
	name: string
	/** Callback URL Unipile posts to on success. */
	apiUrl: string
	/** Notify URL Unipile posts to for out-of-band status. Same as apiUrl for v1. */
	notifyUrl: string
	/** ISO-8601 expiry for the hosted wizard link. */
	expiresOn?: string
}

export interface HostedAuthLinkResponse {
	/** URL to redirect the customer to for LinkedIn auth. */
	url: string
	/** Echoed name. */
	name?: string
}

/**
 * Create a Unipile Hosted Auth Wizard link for the LinkedIn provider.
 * Spec §2 — scope-selected via `providers: ['LINKEDIN']`; no Recruiter /
 * Sales Nav in v1. LinkedIn tokens never touch Maskin; Unipile holds them
 * and returns a workspace-agnostic `account_id` on the /callback POST.
 */
export async function createHostedAuthLink(
	req: HostedAuthLinkRequest,
	overrides?: Partial<UnipileClientConfig>,
): Promise<HostedAuthLinkResponse> {
	const { baseUrl, apiKey } = resolveConfig(overrides)
	const body = {
		type: 'create',
		providers: ['LINKEDIN'],
		api_url: req.apiUrl,
		notify_url: req.notifyUrl,
		name: req.name,
		expiresOn: req.expiresOn,
	}
	let res: Response
	try {
		res = await fetch(`${baseUrl}/api/v1/hosted/accounts/link`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-API-KEY': apiKey,
			},
			body: JSON.stringify(body),
		})
	} catch (err) {
		throw new UnipileUnavailableError(err)
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new UnipileUnavailableError(
			new Error(`Unipile hosted-link creation failed: HTTP ${res.status} ${text}`),
		)
	}
	const parsed = (await res.json()) as HostedAuthLinkResponse
	if (!parsed?.url) {
		throw new UnipileUnavailableError(new Error('Unipile hosted-link response missing url'))
	}
	return parsed
}

// ── Webhook signature verify ──────────────────────────────────────────────

/**
 * Verify Unipile's HMAC-SHA256 signature on a callback body. Unipile sends
 * the signature as a hex digest in a request header (see WEBHOOK_HEADER
 * below); we compute the same digest over the raw body using
 * UNIPILE_WEBHOOK_SECRET and compare with a timing-safe equal.
 *
 * The exact header name Unipile uses is confirmed at partnership setup — we
 * accept a small set of common casings and let the caller pass whatever the
 * request presents.
 */
export const WEBHOOK_HEADER_CANDIDATES = [
	'x-unipile-signature',
	'x-signature',
	'x-webhook-signature',
] as const

export function verifyWebhookSignature(
	rawBody: string,
	signatureHeader: string | null | undefined,
	secretOverride?: string,
): boolean {
	const secret = secretOverride ?? process.env.UNIPILE_WEBHOOK_SECRET ?? ''
	if (!secret) return false
	if (!signatureHeader) return false
	const provided = signatureHeader.trim().replace(/^sha256=/i, '')
	if (!provided) return false
	const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
	const a = Buffer.from(expected, 'utf8')
	const b = Buffer.from(provided.toLowerCase(), 'utf8')
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}
