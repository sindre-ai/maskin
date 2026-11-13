import { type KeyObject, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

/** How the vendor writes the HMAC digest: hex (GitHub, Slack) or base64 (Shopify, Svix). */
export type DigestEncoding = 'hex' | 'base64'

/** Verify HMAC-SHA256 signature with timing-safe comparison */
export function verifyHmacSha256(
	body: string,
	signature: string,
	secret: string,
	prefix?: string,
	encoding: DigestEncoding = 'hex',
): boolean {
	const computed = createHmac('sha256', secret).update(body).digest(encoding)
	const expected = Buffer.from(prefix ? `${prefix}${computed}` : computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

/** Verify HMAC-SHA1 signature with timing-safe comparison */
export function verifyHmacSha1(
	body: string,
	signature: string,
	secret: string,
	prefix?: string,
	encoding: DigestEncoding = 'hex',
): boolean {
	const computed = createHmac('sha1', secret).update(body).digest(encoding)
	const expected = Buffer.from(prefix ? `${prefix}${computed}` : computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

export interface TimestampSignatureConfig {
	/** Header containing the request timestamp */
	timestampHeader: string
	/** Header containing the signature */
	signatureHeader: string
	/** Template for the signing base string. Use `{timestamp}` and `{body}` placeholders. */
	bodyTemplate: string
	/** Prefix prepended to the computed HMAC digest (e.g. 'v0=') */
	signaturePrefix?: string
	/** Digest encoding (default: hex) */
	digestEncoding?: DigestEncoding
	/** Max age in seconds before rejecting (default: 300) */
	maxAgeSeconds?: number
}

/**
 * Verify a timestamp-based HMAC-SHA256 signature.
 * The signing base string is built from the configured template,
 * and the computed digest is compared with timing-safe equality.
 */
export function verifyTimestampSignature(
	body: string,
	headers: Record<string, string>,
	secret: string,
	config: TimestampSignatureConfig,
): boolean {
	const timestamp = headers[config.timestampHeader]
	const signature = headers[config.signatureHeader]
	if (!timestamp || !signature) return false

	// Reject requests older than maxAgeSeconds to prevent replay attacks
	const maxAge = config.maxAgeSeconds ?? 300
	const age = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (age > maxAge) return false

	const baseString = config.bodyTemplate.replace('{timestamp}', timestamp).replace('{body}', body)
	const digest = createHmac('sha256', secret)
		.update(baseString)
		.digest(config.digestEncoding ?? 'hex')
	const computed = config.signaturePrefix ? `${config.signaturePrefix}${digest}` : digest

	const expected = Buffer.from(computed)
	const actual = Buffer.from(signature)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

export interface Ed25519SignatureConfig {
	/** Header containing the request timestamp */
	timestampHeader: string
	/** Header containing the base64 signature */
	signatureHeader: string
	/** Template for the signed text. Use `{timestamp}` and `{body}` placeholders (Telnyx: `{timestamp}|{body}`). */
	bodyTemplate: string
	/** Max age in seconds before rejecting (default: 300) */
	maxAgeSeconds?: number
}

/**
 * Read a vendor's Ed25519 public key: the raw 32 bytes, base64 encoded (the form
 * the Telnyx portal shows). Throws a plain message when it is anything else.
 */
export function parseEd25519PublicKey(encoded: string): KeyObject {
	const raw = Buffer.from(encoded.trim(), 'base64')
	if (raw.length !== 32) {
		throw new Error('Not an Ed25519 public key. Paste the 32-byte public key as base64.')
	}
	return createPublicKey({
		key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
		format: 'jwk',
	})
}

/** Plain reason a stored Ed25519 public key cannot be used, or null when it can. */
export function ed25519PublicKeyError(encoded: string): string | null {
	try {
		parseEd25519PublicKey(encoded)
		return null
	} catch (err) {
		return err instanceof Error ? err.message : String(err)
	}
}

/**
 * Verify an Ed25519 signature over the configured signing text. `publicKey` is
 * the vendor's public key (see parseEd25519PublicKey); a key that cannot be read
 * throws, so a misconfigured extension is a 500, not a silent 401.
 */
export function verifyEd25519Signature(
	body: string,
	headers: Record<string, string>,
	publicKey: string,
	config: Ed25519SignatureConfig,
): boolean {
	const key = parseEd25519PublicKey(publicKey)
	const timestamp = headers[config.timestampHeader]
	const signature = headers[config.signatureHeader]
	if (!timestamp || !signature) return false

	// Reject requests older than maxAgeSeconds to prevent replay attacks
	const maxAge = config.maxAgeSeconds ?? 300
	const age = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (!(age <= maxAge)) return false

	const signed = Buffer.from(
		config.bodyTemplate.replace('{timestamp}', () => timestamp).replace('{body}', () => body),
	)
	const sig = Buffer.from(signature, 'base64')
	// An Ed25519 signature is always 64 bytes; anything else cannot verify.
	if (sig.length !== 64) return false
	return verify(null, signed, key, sig)
}

/** True when `signature` equals any of `candidates`, comparing every one in constant time. */
function matchesAny(candidates: string[], signature: string): boolean {
	const expected = Buffer.from(signature)
	let matched = false
	for (const candidate of candidates) {
		const actual = Buffer.from(candidate)
		if (actual.length === expected.length && timingSafeEqual(actual, expected)) matched = true
	}
	return matched
}

/** True when the unix-seconds timestamp is a number within maxAgeSeconds of now, either side. */
function isFreshTimestamp(timestamp: string, maxAgeSeconds: number): boolean {
	const age = Math.abs(Date.now() / 1000 - Number(timestamp))
	return age <= maxAgeSeconds
}

export interface StandardWebhooksConfig {
	/** Header with the unique message id (webhook-id; Svix's own name is svix-id) */
	idHeader: string
	/** Header with the unix-seconds timestamp (webhook-timestamp) */
	timestampHeader: string
	/** Header with the space-separated list of "v1,<base64>" signatures (webhook-signature) */
	signatureHeader: string
	/** Max age in seconds before rejecting (default: 300) */
	maxAgeSeconds?: number
}

/**
 * Verify a Standard Webhooks delivery (https://www.standardwebhooks.com, used by Svix,
 * Resend, Clerk and others). The signed text is "<id>.<timestamp>.<body>", signed with
 * HMAC-SHA256 under the base64-decoded secret ("whsec_" prefix optional) and written as
 * base64. The header may carry several signatures during a secret rotation; any "v1"
 * entry that matches is enough.
 */
export function verifyStandardWebhooks(
	body: string,
	headers: Record<string, string>,
	secret: string,
	config: StandardWebhooksConfig,
): boolean {
	const id = headers[config.idHeader]
	const timestamp = headers[config.timestampHeader]
	const header = headers[config.signatureHeader]
	if (!id || !timestamp || !header) return false
	if (!isFreshTimestamp(timestamp, config.maxAgeSeconds ?? 300)) return false

	const key = Buffer.from(
		secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
		'base64',
	)
	if (key.length === 0) return false
	const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')

	const candidates = header
		.split(' ')
		.filter((entry) => entry.startsWith('v1,'))
		.map((entry) => entry.slice('v1,'.length))
	return matchesAny(candidates, expected)
}

export interface StripeSignatureConfig {
	/** Header carrying "t=<unix seconds>,v1=<hex>[,v1=<hex>...]" (Stripe-Signature) */
	signatureHeader: string
	/** Max age in seconds before rejecting (default: 300) */
	maxAgeSeconds?: number
}

/**
 * Verify a Stripe-style delivery: one header holds the timestamp (t=) and one or more
 * v1= signatures. The signed text is "<t>.<body>", signed with HMAC-SHA256 under the
 * secret as given and written as hex. Other keys in the header (v0=) are ignored.
 */
export function verifyStripeSignature(
	body: string,
	headers: Record<string, string>,
	secret: string,
	config: StripeSignatureConfig,
): boolean {
	const header = headers[config.signatureHeader]
	if (!header) return false

	let timestamp: string | undefined
	const candidates: string[] = []
	for (const part of header.split(',')) {
		const at = part.indexOf('=')
		if (at < 0) continue
		const key = part.slice(0, at).trim()
		const value = part.slice(at + 1).trim()
		if (key === 't') timestamp ??= value
		else if (key === 'v1') candidates.push(value)
	}
	if (!timestamp || candidates.length === 0) return false
	if (!isFreshTimestamp(timestamp, config.maxAgeSeconds ?? 300)) return false

	const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
	return matchesAny(candidates, expected)
}
