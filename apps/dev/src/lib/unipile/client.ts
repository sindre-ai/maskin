// Minimal Unipile HTTP client — only the two endpoints the self-serve
// LinkedIn connect flow needs: create a hosted-auth link and read the account
// back on callback. If more of Unipile's API becomes needed (send message,
// list conversations), extend this file rather than adding a second client.
//
// Unipile's hosted-auth model: POST /api/v1/hosted/accounts/link returns a
// one-time URL the user is sent to. When they finish, Unipile redirects them
// to the `success_redirect_url` we provided and echoes back the `name` we
// supplied — the same nonce we validate in the callback. The created account
// is discoverable via GET /api/v1/accounts?name=<our-name>.

import { logger } from '../logger'

const HOSTED_LINK_TTL_SECONDS = 60 * 15

export interface UnipileHostedAuthLink {
	url: string
}

export interface UnipileAccount {
	object: 'Account'
	id: string
	name?: string
	type?: string
	created_at?: string
	connection_params?: {
		mailbox?: { name?: string; provider_id?: string }
		im?: { username?: string; provider_id?: string; premium_id?: string }
	}
}

interface CreateHostedAuthLinkInput {
	name: string
	successRedirectUrl: string
	failureRedirectUrl: string
	notifyUrl?: string
}

export interface UnipileClientConfig {
	apiKey: string
	dsn: string
}

/**
 * Returns config from env if both UNIPILE_API_KEY and UNIPILE_DSN are set,
 * otherwise null. Callers use the null return to short-circuit to a clear
 * 501 rather than hitting Unipile with an empty auth header.
 */
export function readUnipileConfig(): UnipileClientConfig | null {
	const apiKey = process.env.UNIPILE_API_KEY
	const dsn = process.env.UNIPILE_DSN
	if (!apiKey || !dsn) return null
	return { apiKey, dsn }
}

function baseUrl(dsn: string): string {
	const trimmed = dsn.trim().replace(/\/+$/, '')
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
	return `https://${trimmed}`
}

async function unipileFetch(
	config: UnipileClientConfig,
	path: string,
	init: RequestInit,
): Promise<Response> {
	const url = `${baseUrl(config.dsn)}${path}`
	const res = await fetch(url, {
		...init,
		headers: {
			'X-API-KEY': config.apiKey,
			accept: 'application/json',
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...(init.headers as Record<string, string> | undefined),
		},
	})
	if (!res.ok) {
		const bodyText = await res.text().catch(() => '')
		logger.warn('Unipile API returned non-2xx', {
			path,
			status: res.status,
			body: bodyText.slice(0, 500),
		})
		throw new UnipileApiError(res.status, path, bodyText)
	}
	return res
}

export class UnipileApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`Unipile API ${path} → ${status}`)
		this.name = 'UnipileApiError'
	}
}

/**
 * Create a per-customer hosted-auth link. `name` is our internal nonce, which
 * Unipile echoes back in the success redirect query params and on the account
 * record — that's the join key on callback.
 */
export async function createHostedAuthLink(
	config: UnipileClientConfig,
	input: CreateHostedAuthLinkInput,
): Promise<UnipileHostedAuthLink> {
	const expiresOn = new Date(Date.now() + HOSTED_LINK_TTL_SECONDS * 1000).toISOString()
	const body = {
		type: 'create',
		providers: ['LINKEDIN'],
		api_url: baseUrl(config.dsn),
		expiresOn,
		name: input.name,
		success_redirect_url: input.successRedirectUrl,
		failure_redirect_url: input.failureRedirectUrl,
		...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
	}
	const res = await unipileFetch(config, '/api/v1/hosted/accounts/link', {
		method: 'POST',
		body: JSON.stringify(body),
	})
	const json = (await res.json()) as { url?: string; object?: string }
	if (!json.url) {
		throw new UnipileApiError(200, '/api/v1/hosted/accounts/link', JSON.stringify(json))
	}
	return { url: json.url }
}

/**
 * Fetch a single account by the `name` we supplied when creating the hosted-
 * auth link. Unipile responds with { items: [Account, ...] } — for a name we
 * generated per-connect there is at most one match.
 */
export async function findAccountByName(
	config: UnipileClientConfig,
	name: string,
): Promise<UnipileAccount | null> {
	const path = `/api/v1/accounts?name=${encodeURIComponent(name)}`
	const res = await unipileFetch(config, path, { method: 'GET' })
	const json = (await res.json()) as { items?: UnipileAccount[] }
	return json.items?.[0] ?? null
}

/**
 * Fetch a single account by Unipile's account id — used when the callback
 * receives `account_id` in the redirect query params directly.
 */
export async function getAccountById(
	config: UnipileClientConfig,
	accountId: string,
): Promise<UnipileAccount | null> {
	const path = `/api/v1/accounts/${encodeURIComponent(accountId)}`
	try {
		const res = await unipileFetch(config, path, { method: 'GET' })
		return (await res.json()) as UnipileAccount
	} catch (err) {
		if (err instanceof UnipileApiError && err.status === 404) return null
		throw err
	}
}

/** Pull the sending-as identity out of the Unipile account payload. */
export function extractSendingAs(account: UnipileAccount): {
	name: string | null
	providerId: string | null
} {
	const im = account.connection_params?.im
	return {
		name: im?.username ?? null,
		providerId: im?.provider_id ?? null,
	}
}
