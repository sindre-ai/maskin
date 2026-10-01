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
		body: JSON.stringify({ name: receiveSubdomain }),
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

	const data = (await res.json()) as RawResendDomainResponse
	if (!data.id) {
		throw new DomainRegisterError('resend POST /domains returned no domain id')
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
