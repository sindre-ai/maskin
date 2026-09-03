import { z } from 'zod'
import { UnipileUnavailableError } from './errors'

/**
 * Thin HTTP client for Unipile's Hosted Auth v2 surface. The v1 flow used
 * POST /api/v1/hosted/accounts/link + a POST callback with HMAC-SHA256 body
 * signing; v2 replaces both with POST /v2/auth/link and a GET redirect
 * callback whose only auth is the unguessable `state` round-trip binding.
 * See https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth.
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

// ── POST /v2/auth/link ────────────────────────────────────────────────────

/**
 * Provider casing is `'linkedin'` (lowercase) per the v2 config example
 * convention. Legacy v1 used `'LINKEDIN'` uppercase; both LinkedIn Sales
 * Navigator and Recruiter are LinkedIn products selected inside the wizard,
 * so v1 of this bet stays on the base `'linkedin'` provider only.
 */
export const CreateAuthLinkRequestSchema = z.object({
	providers: z
		.union([
			z.literal('*'),
			z.array(
				z.enum(['linkedin', 'whatsapp', 'instagram', 'telegram', 'gmail', 'outlook', 'imap']),
			),
		])
		.describe(
			'Providers allowed to be linked in this session. Pass ["linkedin"] for v1 of this bet.',
		),
	expires_on: z
		.string()
		.datetime()
		.describe('ISO-8601 UTC timestamp after which the hosted-auth session expires.'),
	redirect_uri: z.string().url().describe('Our Maskin callback URL.'),
	state: z
		.string()
		.min(1)
		.max(128)
		.describe(
			'Opaque round-trip identifier. We set this to the pending integrations.id so /callback can look up the row.',
		),
})
export type CreateAuthLinkRequest = z.infer<typeof CreateAuthLinkRequestSchema>

export const CreateAuthLinkResponseSchema = z.object({
	data: z.object({
		link: z.string().url().describe('URL to redirect the user to for the Unipile-hosted wizard.'),
	}),
})
export type CreateAuthLinkResponse = z.infer<typeof CreateAuthLinkResponseSchema>

/**
 * Create a Unipile v2 hosted-auth link. v1's `POST /api/v1/hosted/accounts/link`
 * with `{ api_url, notify_url, name }` is replaced by
 * `POST /v2/auth/link` with `{ providers, expires_on, redirect_uri, state }`
 * and the response nests the URL under `data.link` (v1 returned `url` at
 * the top level).
 */
export async function createAuthLink(
	req: CreateAuthLinkRequest,
	overrides?: Partial<UnipileClientConfig>,
): Promise<CreateAuthLinkResponse> {
	const { baseUrl, apiKey } = resolveConfig(overrides)
	let res: Response
	try {
		res = await fetch(`${baseUrl}/v2/auth/link`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-API-KEY': apiKey,
				Accept: 'application/json',
			},
			body: JSON.stringify({
				providers: req.providers,
				expires_on: req.expires_on,
				redirect_uri: req.redirect_uri,
				state: req.state,
			}),
		})
	} catch (err) {
		throw new UnipileUnavailableError(err)
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new UnipileUnavailableError(
			new Error(`Unipile create auth link failed: HTTP ${res.status} ${text}`),
		)
	}
	const parsed = CreateAuthLinkResponseSchema.safeParse(await res.json())
	if (!parsed.success) {
		throw new UnipileUnavailableError(
			new Error('Unipile auth-link response failed schema validation'),
		)
	}
	return parsed.data
}
