import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { CustomerValueError } from './customer-value'

/** Loopback, private, link-local, shared-address and unspecified addresses, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const a = address.toLowerCase()
		if (
			a === '::1' ||
			a === '::' ||
			a.startsWith('fe80') ||
			a.startsWith('fc') ||
			a.startsWith('fd')
		)
			return true
		// IPv4 inside IPv6 (::ffff:a.b.c.d or ::a.b.c.d). new URL() rewrites the
		// dotted tail to hex (::ffff:7f00:1), so accept both spellings.
		const embedded = a.match(
			/^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
		)
		if (!embedded) return false
		if (embedded[1]) return isPrivateAddress(embedded[1])
		const hi = Number.parseInt(embedded[2] ?? '0', 16)
		const lo = Number.parseInt(embedded[3] ?? '0', 16)
		return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
	}
	const [a = 0, b = 0] = address.split('.').map(Number)
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	)
}

/** Also refuses what is never a public host: multicast, reserved, benchmarking and IETF-protocol ranges. */
export function isNonPublicAddress(address: string): boolean {
	if (isPrivateAddress(address)) return true
	if (isIP(address) === 4) {
		const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
		return a >= 224 || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0)
	}
	const lower = address.toLowerCase()
	return lower.startsWith('ff') || lower.startsWith('fec0') || lower.startsWith('2001:db8')
}

/**
 * Looks the host up and refuses it unless every address it resolves to is public. Run before each
 * request to a host a customer typed, so a name that once pointed at a vendor and now points inside
 * our network is never called. The request that follows resolves the name again, so a resolver that
 * answers differently between the two is not covered; the vendor-domain check on the value is what
 * limits who controls that answer.
 */
export async function assertPublicHost(
	host: string,
	resolve: (host: string) => Promise<string[]> = async (h) =>
		(await lookup(h, { all: true })).map((r) => r.address),
): Promise<void> {
	let addresses: string[]
	try {
		addresses = isIP(host) ? [host] : await resolve(host)
	} catch {
		throw new CustomerValueError("Couldn't find that address.")
	}
	if (addresses.length === 0) throw new CustomerValueError("Couldn't find that address.")
	if (addresses.some(isNonPublicAddress)) {
		throw new CustomerValueError('That address is not reachable from here.')
	}
}
