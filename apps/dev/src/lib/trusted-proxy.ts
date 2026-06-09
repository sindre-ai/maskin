import { logger } from './logger'

// Trusted-proxy CIDR validation.
//
// X-Forwarded-For is only honoured when the socket-level remote address
// belongs to a known edge proxy, preventing per-IP throttle spoofing if the
// endpoint is ever reached without the edge in front. Configure via the
// TRUSTED_PROXY_CIDRS env var (comma-separated CIDR blocks).
// Default: loopback only (127.0.0.1/32,::1/128).

type Ipv4Cidr = { family: 4; network: number; mask: number }
type Ipv6Prefix = { family: 6; address: string }
type ParsedCidr = Ipv4Cidr | Ipv6Prefix

function parseIpv4Int(addr: string): number | null {
	const parts = addr.split('.')
	if (parts.length !== 4) return null
	let result = 0
	for (const part of parts) {
		const octet = Number(part)
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
		result = ((result << 8) | octet) >>> 0
	}
	return result
}

function parseIpv4Cidr(cidr: string): Ipv4Cidr | null {
	const slashIdx = cidr.indexOf('/')
	if (slashIdx === -1) return null
	const addr = cidr.slice(0, slashIdx)
	const prefix = Number(cidr.slice(slashIdx + 1))
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
	const ip = parseIpv4Int(addr)
	if (ip === null) return null
	const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
	return { family: 4, network: ip & mask, mask }
}

function parseCidrs(raw: string): ParsedCidr[] {
	const result: ParsedCidr[] = []
	for (const entry of raw.split(',')) {
		const cidr = entry.trim()
		if (!cidr) continue
		if (cidr.includes(':')) {
			// IPv6: equality-only match on the address portion. The prefix length is
			// silently ignored — only /128 (single host) behaves correctly. A subnet
			// like fd00::/8 will only match fd00:: exactly, not the full subnet.
			const slashIdx = cidr.indexOf('/')
			const prefix = slashIdx !== -1 ? Number(cidr.slice(slashIdx + 1)) : 128
			if (prefix !== 128) {
				logger.warn(
					'trusted-proxy: IPv6 CIDR is not /128 - subnet matching is not supported; only the exact host address will be trusted',
					{ cidr },
				)
			}
			result.push({ family: 6, address: cidr.split('/')[0] ?? cidr })
			continue
		}
		const parsed = parseIpv4Cidr(cidr)
		if (!parsed) {
			logger.warn('trusted-proxy: invalid TRUSTED_PROXY_CIDRS entry, skipping', { cidr })
			continue
		}
		result.push(parsed)
	}
	return result
}

function isInCidr(socketIp: string, cidr: ParsedCidr): boolean {
	// Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) for uniform matching.
	const ip = socketIp.replace(/^::ffff:/i, '')
	if (cidr.family === 6) {
		return ip === cidr.address || socketIp === cidr.address
	}
	const ipInt = parseIpv4Int(ip)
	if (ipInt === null) return false
	return (ipInt & cidr.mask) === cidr.network
}

let _trustedCidrs: ParsedCidr[] | null = null

function getTrustedCidrs(): ParsedCidr[] {
	if (_trustedCidrs === null) {
		_trustedCidrs = parseCidrs(process.env.TRUSTED_PROXY_CIDRS ?? '127.0.0.1/32,::1/128')
	}
	return _trustedCidrs
}

// Test-only: re-parse TRUSTED_PROXY_CIDRS after env changes.
export function _resetTrustedCidrs(): void {
	_trustedCidrs = null
}

// Resolves the real client IP. X-Forwarded-For is only trusted when the
// socket-level remote address is in the configured trusted proxy CIDR list.
// Falls back to the socket address directly (or 'unknown') when the request
// does not arrive from a known proxy — making spoofing impossible even if the
// endpoint is accidentally exposed without the edge in front.
export function extractClientIp(socketIp: string | undefined, fwd: string | undefined): string {
	if (socketIp && fwd) {
		const cidrs = getTrustedCidrs()
		if (cidrs.some((c) => isInCidr(socketIp, c))) {
			const first = fwd.split(',')[0]?.trim()
			if (first) return first
		}
	}
	return socketIp || 'unknown'
}
