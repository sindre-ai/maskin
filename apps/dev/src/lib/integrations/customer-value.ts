import type { CustomerValueConfig } from './types'

/** Where a tool's setup puts the customer's own value in a sign-in or server address. */
export const CUSTOMER_VALUE_TOKEN = '{value}'

export class CustomerValueError extends Error {
	readonly status = 400
	readonly code = 'BAD_REQUEST'
	constructor(message: string) {
		super(message)
		this.name = 'CustomerValueError'
	}
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// A Microsoft tenant id: a GUID.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Suffixes that never name a public host, refused even when a tool sets no suffix of its own.
const INTERNAL_SUFFIXES = ['local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp']

function checkHost(raw: string, spec: CustomerValueConfig): string {
	const fail = (reason: string) => new CustomerValueError(`${spec.label}: ${reason}`)
	const host = raw.trim().toLowerCase()
	// Only letters, digits, dots and hyphens: no scheme, path, port, user, query or IP literal.
	if (!/^[a-z0-9.-]+$/.test(host)) {
		throw fail('enter only the host name, for example name.looker.com, without https:// or a path.')
	}
	if (host.length > 253) throw fail('that is too long.')
	const labels = host.split('.')
	if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) {
		throw fail('that is not a valid host name.')
	}
	// The last label of a public name has a letter, which also rules out 127.0.0.1 and 0x7f.1.
	const tld = labels[labels.length - 1] ?? ''
	if (!/[a-z]/.test(tld) || INTERNAL_SUFFIXES.includes(tld)) {
		throw fail('that is not a public host name.')
	}
	const suffixes = spec.hostSuffixes
	if (suffixes && suffixes.length > 0) {
		const ok = suffixes.some((s) => host.endsWith(`.${s}`) && host.length > s.length + 1)
		if (!ok) throw fail(`it must end in ${suffixes.map((s) => `.${s}`).join(' or ')}.`)
	}
	return host
}

function checkTenant(raw: string, spec: CustomerValueConfig): string {
	const value = raw.trim().toLowerCase()
	if (GUID.test(value)) return value
	// A verified domain of the tenant, such as contoso.onmicrosoft.com, is accepted too.
	const labels = value.split('.')
	const tld = labels[labels.length - 1] ?? ''
	if (
		/^[a-z0-9.-]+$/.test(value) &&
		value.length <= 253 &&
		labels.length >= 2 &&
		labels.every((l) => HOST_LABEL.test(l)) &&
		/[a-z]/.test(tld) &&
		!INTERNAL_SUFFIXES.includes(tld)
	) {
		return value
	}
	throw new CustomerValueError(
		`${spec.label}: enter the directory (tenant) id, like 11111111-2222-3333-4444-555555555555, or its domain.`,
	)
}

/**
 * The customer's value, trimmed and lower-cased, or a CustomerValueError that says in plain words
 * what is wrong. Run before a value is saved and again before it is put into any address, because
 * the address is one Maskin's server then calls or sends a person to. It is never trusted just
 * because it was stored.
 */
export function validateCustomerValue(spec: CustomerValueConfig, raw: unknown): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new CustomerValueError(`${spec.label} is required.`)
	}
	return spec.kind === 'host' ? checkHost(raw, spec) : checkTenant(raw, spec)
}

/** True when the address has a place for the customer's value. */
export function hasCustomerValueToken(template: string): boolean {
	return template.includes(CUSTOMER_VALUE_TOKEN)
}

/**
 * The address with the customer's value in it. An address with no place for it comes back
 * unchanged. A tool that needs a value and has none is an error, never a half-built address.
 */
export function fillCustomerValue(
	template: string,
	spec: CustomerValueConfig | undefined,
	value: string | undefined,
): string {
	if (!hasCustomerValueToken(template)) return template
	if (!spec) throw new Error('This address needs a customer value but the tool declares none')
	if (!value) throw new CustomerValueError(`${spec.label} is required.`)
	const checked = validateCustomerValue(spec, value)
	return template.split(CUSTOMER_VALUE_TOKEN).join(checked)
}
