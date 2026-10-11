/**
 * MX pre-check shared by POST /resend/dns-precheck (advisory, called by the
 * connect dialog) and POST /resend/connect (enforced server-side). Both
 * routes must agree on what counts as a bare domain with existing mail, so
 * the rule lives here once.
 */
import { promises as dns } from 'node:dns'
import { logger } from '../../../logger'

export interface ResendDnsPrecheck {
	existingMx: string[]
	isSubdomain: boolean
	warn: boolean
}

// A subdomain has at least three labels (mail.example.com → true;
// example.com → false). Sending on a bare apex changes the whole domain's
// mail routing, whereas a subdomain is carved out. Known gap: example.co.uk
// counts as three labels.
export function isSubdomainName(domain: string): boolean {
	return domain.split('.').length >= 3
}

export async function precheckResendDomain(domain: string): Promise<ResendDnsPrecheck> {
	const isSubdomain = isSubdomainName(domain)

	let existingMx: string[] = []
	try {
		const records = await dns.resolveMx(domain)
		existingMx = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
			logger.warn('resend.dns_precheck.error', { domain, err: String(err) })
		}
	}

	const isResendMx = existingMx.some(
		(h) => h.toLowerCase().includes('resend') || h.toLowerCase().includes('amazonses'),
	)
	const warn = !isSubdomain && existingMx.length > 0 && !isResendMx
	return { existingMx, isSubdomain, warn }
}

const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

// Basic hostname shape: at least two dot-separated labels of letters, digits
// and inner hyphens, 253 characters at most.
export function isValidHostname(name: string): boolean {
	if (name.length > 253) return false
	const labels = name.split('.')
	return labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL_RE.test(label))
}
