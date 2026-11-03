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
 * Resend allows same-account duplicate domain names, so that 409 branch is a
 * fallback only. /connect first looks the name up in the account
 * (findResendDomainByName) and adopts an existing domain (adoptResendDomain)
 * instead of creating a second one.
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

export interface ResendDomainListPage {
	data?: Array<{ id?: string; name?: string }>
	has_more?: boolean
}

interface RawResendError {
	name?: string
	message?: string
	statusCode?: number
}

function toRegisterResult(data: RawResendDomainResponse): RegisterResendDomainResult {
	if (!data.id) {
		throw new DomainRegisterError('resend returned no domain id')
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

async function throwResendError(res: Response, label: string): Promise<never> {
	const errBody = (await res.json().catch(() => null)) as RawResendError | null
	throw new DomainRegisterError(
		errBody?.message ?? `resend ${label} returned ${res.status}`,
		res.status,
		errBody?.name,
	)
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
		// Resend leaves receiving disabled unless asked, so a fresh domain would
		// never get the MX record the inbound path needs.
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

	return toRegisterResult((await res.json()) as RawResendDomainResponse)
}

/**
 * Look a domain up by name in the caller's Resend account. Resend has no name
 * filter, so scan the list (case-insensitive), following has_more with
 * limit=100 and after=<last id>. firstPage is the response /connect already
 * fetched to verify the key. Returns the domain id, or null when absent.
 */
export async function findResendDomainByName(
	apiKey: string,
	name: string,
	firstPage: ResendDomainListPage,
): Promise<string | null> {
	const wanted = name.trim().toLowerCase()
	let page = firstPage
	for (;;) {
		const rows = page.data ?? []
		for (const row of rows) {
			if (row.id && row.name?.trim().toLowerCase() === wanted) return row.id
		}
		const last = rows[rows.length - 1]
		if (!page.has_more || !last?.id) return null
		const res = await fetch(
			`https://api.resend.com/domains?limit=100&after=${encodeURIComponent(last.id)}`,
			{
				method: 'GET',
				headers: { Authorization: `Bearer ${apiKey}` },
			},
		)
		if (!res.ok) await throwResendError(res, 'GET /domains')
		page = (await res.json()) as ResendDomainListPage
	}
}

async function getResendDomain(
	apiKey: string,
	domainId: string,
): Promise<{ result: RegisterResendDomainResult; receiving: string | undefined }> {
	const res = await fetch(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	if (!res.ok) await throwResendError(res, 'GET /domains/:id')
	const data = (await res.json()) as RawResendDomainResponse
	const caps = data.capabilities as { receiving?: string } | null | undefined
	return {
		result: toRegisterResult({ ...data, id: data.id ?? domainId }),
		receiving: caps?.receiving,
	}
}

/**
 * Reuse a domain that already exists in the same Resend account: read its
 * records and status, and turn receiving on if it is off (sending untouched),
 * then re-read so the MX record is included. Throws if any Resend call fails,
 * so /connect never inserts a row for a half-adopted domain.
 */
export async function adoptResendDomain(
	apiKey: string,
	domainId: string,
): Promise<RegisterResendDomainResult> {
	let domain = await getResendDomain(apiKey, domainId)
	if (domain.receiving !== 'enabled') {
		const res = await fetch(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ capabilities: { receiving: 'enabled' } }),
		})
		if (!res.ok) await throwResendError(res, 'PATCH /domains/:id')
		domain = await getResendDomain(apiKey, domainId)
	}
	return domain.result
}
