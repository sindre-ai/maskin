import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { CustomerValueError } from './customer-value'

/**
 * An IPv6 address as eight 16-bit groups, or null when it is not valid IPv6. Reads every spelling
 * of the same address the same way: compressed (::ffff:7f00:1), written out in full
 * (0:0:0:0:0:ffff:7f00:1), and with a dotted IPv4 tail (::ffff:127.0.0.1). A zone id (%eth0) is dropped.
 */
export function parseIPv6(address: string): number[] | null {
	const bare = address.split('%')[0]?.toLowerCase() ?? ''
	if (isIP(bare) !== 6) return null
	let text = bare
	const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
	if (dotted) {
		const [a = 0, b = 0, c = 0, d = 0] = (dotted[2] as string).split('.').map(Number)
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
	}
	const halves = text.split('::')
	if (halves.length > 2) return null
	const head = halves[0] ? (halves[0] as string).split(':') : []
	const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : []
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
	const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => Number.parseInt(g, 16))
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
		? groups
		: null
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/**
 * The IPv4 address an IPv6 address carries, when it is one of the forms that reach an IPv4 host:
 * IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d),
 * NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::). Written in any spelling, compressed or in
 * full, dotted or hex. Null for an address that carries none.
 */
export function embeddedIPv4(address: string): string | null {
	const g = parseIPv6(address)
	if (!g) return null
	const lead = (n: number) => g.slice(0, n).every((x) => x === 0)
	if (lead(5) && g[5] === 0xffff) return v4From(g[6] as number, g[7] as number)
	if (lead(4) && g[4] === 0xffff && g[5] === 0) return v4From(g[6] as number, g[7] as number)
	if (lead(6) && (g[6] !== 0 || (g[7] as number) > 1)) return v4From(g[6] as number, g[7] as number)
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
		return v4From(g[6] as number, g[7] as number)
	}
	if (g[0] === 0x2002) return v4From(g[1] as number, g[2] as number)
	return null
}

/** Loopback, private, link-local, shared-address and unspecified addresses, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const g = parseIPv6(address)
		// Not parseable as IPv6 even though it looks like it: never call it public.
		if (!g) return true
		const embedded = embeddedIPv4(address)
		if (embedded) return isPrivateAddress(embedded)
		const first = g[0] as number
		const loopbackOrUnspecified = g.slice(0, 7).every((x) => x === 0) && (g[7] as number) <= 1
		// fe80::/10 link-local, fc00::/7 unique local.
		return loopbackOrUnspecified || (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00
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
	const embedded = embeddedIPv4(address)
	if (embedded) return isNonPublicAddress(embedded)
	const g = parseIPv6(address)
	if (!g) return true
	const first = g[0] as number
	return (
		(first & 0xff00) === 0xff00 || // multicast
		(first & 0xffc0) === 0xfec0 || // site-local, deprecated
		(first === 0x2001 && g[1] === 0x0db8) || // documentation
		(first === 0x2001 && g[1] === 0) || // Teredo: the IPv4 address is hidden in it
		(first === 0x64 && g[1] === 0xff9b && g[2] === 1) // local-use NAT64
	)
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
