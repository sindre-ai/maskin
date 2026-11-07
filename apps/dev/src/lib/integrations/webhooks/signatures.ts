import { type KeyObject, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

/** Verify HMAC-SHA256 signature with timing-safe comparison */
export function verifyHmacSha256(
	body: string,
	signature: string,
	secret: string,
	prefix?: string,
): boolean {
	const computed = createHmac('sha256', secret).update(body).digest('hex')
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
): boolean {
	const computed = createHmac('sha1', secret).update(body).digest('hex')
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
	/** Prefix prepended to the computed HMAC hex digest (e.g. 'v0=') */
	signaturePrefix?: string
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
	const digest = createHmac('sha256', secret).update(baseString).digest('hex')
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
