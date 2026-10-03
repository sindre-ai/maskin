/**
 * Thin wrapper around Resend's POST /domains endpoint. Called from the
 * two-call handshake's /connect body-branch (spec §2 + §Load-bearing #3):
 * the extended /connect flow verifies the customer's Resend API key, then
 * hits POST /domains here to register the receive subdomain on their own
 * Resend account. The response DNS records are what the Slice 2 UI shows
 * the customer to paste into their DNS provider.
 *
 * The already-claimed case (409 / domain_already_verified /
 * domain_already_exists) throws DomainAlreadyClaimedError so the route
 * handler can translate it to a 400 with { code: 'DOMAIN_ALREADY_CLAIMED' }
 * for the Step 2 error state. Any other non-2xx becomes a
 * DomainRegisterError the handler surfaces as an upstream failure.
 *
 * Resend allows same-account duplicate domains, so that 409 branch is only a
 * fallback. The route first looks the domain up by name (findResendDomainByName)
 * and adopts an existing one (adoptResendDomain) instead of creating a copy.
 */

export interface ResendDnsRecord {
	record: string
	type: string
	name: string
	value: string
	priority?: number
	status: string
}

export interface RegisterResendDomainResult {
	resendDomainId: string
	dnsRecords: ResendDnsRecord[]
	verificationStatus: string
	capabilities: unknown
}

export class DomainAlreadyClaimedError extends Error {
	constructor(readonly resendCode?: string) {
		super('resend domain already claimed')
		this.name = 'DomainAlreadyClaimedError'
	}
}

export class DomainRegisterError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly resendCode?: string,
	) {
		super(message)
		this.name = 'DomainRegisterError'
	}
}

const RESEND_ALREADY_CLAIMED_CODES = new Set([
	'domain_already_verified',
	'domain_already_exists',
	'validation_error', // Resend surfaces some duplicate-name failures under this generic code
])

interface RawResendDomainResponse {
	id?: string
	name?: string
	status?: string
	records?: Array<{
		record?: string
		type?: string
		name?: string
		value?: string
		priority?: number
		status?: string
	}>
	capabilities?: unknown
}

interface RawResendDomainListResponse {
	data?: Array<{ id?: string; name?: string }>
	has_more?: boolean
}

interface RawResendError {
	name?: string
	message?: string
	statusCode?: number
}

export async function registerResendDomain(
	apiKey: string,
	receiveSubdomain: string,
): Promise<RegisterResendDomainResult> {
	const res = await fetch('https://api.resend.com/domains', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: receiveSubdomain,
			capabilities: { sending: 'enabled', receiving: 'enabled' },
		}),
	})

	if (!res.ok) {
		const errBody = (await res.json().catch(() => null)) as RawResendError | null
		const code = errBody?.name
		if (res.status === 409 || (code && RESEND_ALREADY_CLAIMED_CODES.has(code))) {
			throw new DomainAlreadyClaimedError(code)
		}
		throw new DomainRegisterError(
			errBody?.message ?? `resend POST /domains returned ${res.status}`,
			res.status,
			code,
		)
	}

	return toRegisterResult(
		(await res.json()) as RawResendDomainResponse,
		'resend POST /domains returned no domain id',
	)
}

function toRegisterResult(
	data: RawResendDomainResponse,
	missingIdMessage: string,
): RegisterResendDomainResult {
	if (!data.id) {
		throw new DomainRegisterError(missingIdMessage)
	}
	const records: ResendDnsRecord[] = (data.records ?? []).map((r) => ({
		record: r.record ?? '',
		type: r.type ?? '',
		name: r.name ?? '',
		value: r.value ?? '',
		priority: r.priority,
		status: r.status ?? 'pending',
	}))
	return {
		resendDomainId: data.id,
		dnsRecords: records,
		verificationStatus: data.status ?? 'pending',
		capabilities: data.capabilities ?? null,
	}
}

async function failFromResponse(res: Response, label: string): Promise<never> {
	const errBody = (await res.json().catch(() => null)) as RawResendError | null
	throw new DomainRegisterError(
		errBody?.message ?? `resend ${label} returned ${res.status}`,
		res.status,
		errBody?.name,
	)
}

/**
 * Find a domain by name (case-insensitive) in the customer's Resend account.
 * Resend's list endpoint has no name filter, so we scan the pages: the caller
 * passes the first page it already fetched to verify the API key, and we
 * follow has_more with limit=100 and after=<last id>. Returns the domain id,
 * or null when the account has no domain of that name.
 */
export async function findResendDomainByName(
	apiKey: string,
	name: string,
	firstPage: unknown,
): Promise<string | null> {
	const wanted = name.toLowerCase()
	let page = firstPage as RawResendDomainListResponse | null
	while (page) {
		const rows = page.data ?? []
		const hit = rows.find((d) => d.id && d.name?.toLowerCase() === wanted)
		if (hit?.id) return hit.id
		const lastId = rows[rows.length - 1]?.id
		if (!page.has_more || !lastId) return null
		const res = await fetch(`https://api.resend.com/domains?limit=100&after=${lastId}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
		})
		if (!res.ok) await failFromResponse(res, 'GET /domains')
		page = (await res.json()) as RawResendDomainListResponse
	}
	return null
}

async function getResendDomain(
	apiKey: string,
	resendDomainId: string,
): Promise<RegisterResendDomainResult> {
	const res = await fetch(`https://api.resend.com/domains/${resendDomainId}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	if (!res.ok) await failFromResponse(res, 'GET /domains/:id')
	return toRegisterResult(
		(await res.json()) as RawResendDomainResponse,
		'resend GET /domains/:id returned no domain id',
	)
}

/**
 * Reuse a domain that already exists in the customer's Resend account: read
 * its records and status, and turn receiving on when it is off (sending is
 * left untouched), then re-read so the result carries the new MX record. A
 * failed PATCH throws before the caller inserts any row.
 */
export async function adoptResendDomain(
	apiKey: string,
	resendDomainId: string,
): Promise<RegisterResendDomainResult> {
	const domain = await getResendDomain(apiKey, resendDomainId)
	const receiving = (domain.capabilities as { receiving?: string } | null)?.receiving
	if (receiving === 'enabled') return domain

	const res = await fetch(`https://api.resend.com/domains/${resendDomainId}`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ capabilities: { receiving: 'enabled' } }),
	})
	if (!res.ok) await failFromResponse(res, 'PATCH /domains/:id')
	return getResendDomain(apiKey, resendDomainId)
}
