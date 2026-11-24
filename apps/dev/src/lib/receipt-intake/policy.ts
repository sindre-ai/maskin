import { createHash, randomBytes } from 'node:crypto'

// The rules every receipt route shares: email and the command both pass through these before a
// byte is stored. Pure functions, no I/O, so each rule can be tested on its own.

/** One file: 10 MB. A phone photo of a receipt is well under this. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024
/** Files read from one email. The rest are dropped and counted as held. */
export const RECEIPT_MAX_FILES_PER_MAIL = 5
/** Receipts one flow takes in per UTC day, across both routes. Stops a loop or a flood. */
export const RECEIPT_DAILY_CAP = 50
/** Most allowed senders an owner can list. */
export const RECEIPT_MAX_ALLOWED_SENDERS = 20
/** Most live command keys per flow. */
export const RECEIPT_MAX_KEYS = 5

export type ReceiptType = { mime: string; ext: string }

/**
 * What the bytes are, read from the first bytes and not from the name or the declared type.
 * Only PDF, JPEG, PNG and HEIC are receipts. Anything else returns null and is dropped.
 */
export function sniffReceiptType(bytes: Uint8Array): ReceiptType | null {
	const b = bytes
	if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
		return { mime: 'application/pdf', ext: 'pdf' }
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return { mime: 'image/jpeg', ext: 'jpg' }
	}
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	) {
		return { mime: 'image/png', ext: 'png' }
	}
	// HEIC and HEIF: an ISO box whose type at offset 4 is ftyp, with a heic-family brand at 8.
	if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
		const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0)
		if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
			return { mime: 'image/heic', ext: 'heic' }
		}
	}
	return null
}

/** The address in a From header: "Name <a@b.dk>" or "a@b.dk", lowercased. Null if none. */
export function parseAddress(raw: string | undefined | null): string | null {
	if (!raw) return null
	const angle = raw.match(/<([^<>]+)>\s*$/)
	const candidate = (angle?.[1] ?? raw).trim().toLowerCase()
	return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(candidate) ? candidate : null
}

/**
 * Whether a sender may send receipts. The owner's list wins; an empty list means the owner's own
 * login email and nobody else.
 */
export function senderAllowed(
	from: string | undefined | null,
	allowedSenders: readonly string[],
	ownerEmail: string | null,
): boolean {
	const sender = parseAddress(from)
	if (!sender) return false
	const allowed =
		allowedSenders.length > 0
			? allowedSenders.map((a) => a.toLowerCase())
			: ownerEmail
				? [ownerEmail.toLowerCase()]
				: []
	return allowed.includes(sender)
}

/** Resend's sender checks on a received email. */
export type MailAuthentication = {
	spf?: string
	dkim?: string
	dmarc?: string
} | null

/**
 * Passes only when DMARC says pass. DMARC is the one result that ties the signature to the From
 * address the allowed-sender list reads, so a stranger who signs mail with their own domain and
 * writes the owner's address in From does not pass. A missing, unknown or failed result drops the
 * mail: this fails closed.
 */
export function authenticationPasses(auth: MailAuthentication | undefined): boolean {
	return auth?.dmarc === 'pass'
}

/** Lowercase and keep only real addresses, deduplicated and capped. */
export function normalizeAllowedSenders(list: readonly string[]): string[] {
	const out: string[] = []
	for (const raw of list) {
		const a = parseAddress(raw)
		if (a && !out.includes(a)) out.push(a)
	}
	return out.slice(0, RECEIPT_MAX_ALLOWED_SENDERS)
}

const EMAIL_TOKEN_RE = /^r-[a-z2-7]{32}$/

/** A new random part for a receiving address: 160 bits, so it cannot be guessed. */
export function mintEmailToken(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
	const bytes = randomBytes(32)
	let out = 'r-'
	for (const byte of bytes) out += alphabet[byte & 31]
	return out
}

export function emailAddressFor(token: string, domain: string): string {
	return `${token}@${domain.toLowerCase()}`
}

/** The token in the first recipient that is an address on our receiving domain, else null. */
export function tokenFromRecipients(
	recipients: readonly (string | undefined | null)[],
	domain: string,
): string | null {
	const wanted = domain.toLowerCase()
	for (const r of recipients) {
		const address = parseAddress(r)
		if (!address) continue
		const [local, host] = address.split('@')
		if (host === wanted && local && EMAIL_TOKEN_RE.test(local)) return local
	}
	return null
}

const KEY_PREFIX = 'rck_'

export function mintIntakeKey(): { key: string; hash: string; last4: string } {
	const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
	return { key, hash: hashIntakeKey(key), last4: key.slice(-4) }
}

export function hashIntakeKey(key: string): string {
	return createHash('sha256').update(key).digest('hex')
}

/** The key out of an Authorization header, or null if it is not shaped like one of ours. */
export function intakeKeyFromHeader(header: string | undefined | null): string | null {
	const m = header?.match(/^Bearer\s+(rck_[A-Za-z0-9_-]{20,100})$/)
	return m?.[1] ?? null
}

/** The month a receipt belongs to, from the day it arrived: YYYY-MM in UTC. */
export function monthKey(date: Date): string {
	return date.toISOString().slice(0, 7)
}

export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10)
}
