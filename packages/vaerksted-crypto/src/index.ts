/**
 * @maskin/vaerksted-crypto — Ed25519 keygen, challenge signing, and device-cert
 * issue/verify for vaerksted-auth and vaerksted-sync (design doc §5, §6).
 *
 * Encoding convention: every public key, private key, and signature that
 * crosses this module's API boundary is a **lowercase hex string**, not raw
 * bytes and not base64. Hex was chosen over base64 purely for debuggability
 * (greppable in logs/DB rows, no +/=/ padding ambiguity) — nothing about the
 * protocol depends on it, so this is a convention, not a requirement of
 * Ed25519 itself. Keep it consistent across every caller (vaerksted-auth's
 * routes, vaerksted-sync, and any future client) so certs and signatures
 * always round-trip.
 *
 * Uses `@noble/curves` (pure JS, no native bindings) rather than a
 * libsodium-style native-binding library — see the cross-cutting technical
 * decisions table in `docs/design/vaerksted-auth-and-sync-implementation-plan.md`
 * and `.claude/rules/known-pitfalls.md`'s "Runtime File Reads Relative to
 * `import.meta.url` Break Under esbuild Bundling" entry: native bindings that
 * resolve their `.node`/wasm file relative to `import.meta.url` break under
 * this repo's esbuild single-file bundle (`build.mjs`), and pure JS sidesteps
 * that failure class entirely.
 *
 * Expiry-checking design choice: `verifyCert` below verifies ONLY the
 * cryptographic signature over the cert payload — it deliberately does not
 * check `expiresAt` against the current time. Time-based expiry is left to
 * the caller (vaerksted-auth's `device-cert-middleware.ts`) for two reasons:
 * (1) "is this cert cryptographically genuine" and "is this cert still
 * valid right now" are different questions with different failure modes
 * (a tampered cert is a security event; an expired-but-genuine cert is a
 * routine renewal prompt) and callers often want to distinguish them in
 * their error responses; (2) keeping "now" out of this library keeps it
 * trivially unit-testable without faking the clock — see the "expired cert"
 * test in `src/__tests__/`, which constructs an already-expired cert and
 * confirms verifyCert still reports the signature as valid, then asserts the
 * caller-side expiry check separately.
 */

// Note the explicit `.js` extension — @noble/curves v2's package.json
// `exports` map only defines `./ed25519.js`, not the extensionless
// `./ed25519` some older examples show.
import { ed25519 } from '@noble/curves/ed25519.js'

export type Keypair = {
	publicKey: string
	privateKey: string
}

export type CertPayload = {
	device_id: string
	identity_id: string
	public_key: string
	expires_at: string
}

export type DeviceCert = CertPayload & {
	signature: string
}

function bytesToHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('hex')
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
		throw new Error('Invalid hex string')
	}
	return new Uint8Array(Buffer.from(hex, 'hex'))
}

function utf8ToBytes(str: string): Uint8Array {
	return new Uint8Array(Buffer.from(str, 'utf8'))
}

/** Canonical (fixed-key-order) JSON serialization of a challenge payload. */
function canonicalChallengePayload(nonce: string, timestamp: number): string {
	return JSON.stringify({ nonce, timestamp })
}

/** Canonical (fixed-key-order) JSON serialization of a device-cert payload. */
function canonicalCertPayload(payload: CertPayload): string {
	return JSON.stringify({
		device_id: payload.device_id,
		identity_id: payload.identity_id,
		public_key: payload.public_key,
		expires_at: payload.expires_at,
	})
}

/**
 * Generates a new Ed25519 keypair. Used both for a device's own keypair
 * (generated on-device per §6 step 1) and for vaerksted-auth's own signing
 * ("CA") keypair that backs `issueCert`/`verifyCert`.
 */
export function generateKeypair(): Keypair {
	const privateKeyBytes = ed25519.utils.randomSecretKey()
	const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes)
	return {
		publicKey: bytesToHex(publicKeyBytes),
		privateKey: bytesToHex(privateKeyBytes),
	}
}

/**
 * Signs `{nonce, timestamp}` with a device's private key — the request-side
 * half of the challenge-response handshake in design doc §6 step 4.
 */
export function signChallenge(privateKey: string, nonce: string, timestamp: number): string {
	const message = utf8ToBytes(canonicalChallengePayload(nonce, timestamp))
	const signature = ed25519.sign(message, hexToBytes(privateKey))
	return bytesToHex(signature)
}

/**
 * Verifies a challenge signature against the device's public key. Returns
 * `false` (never throws) for a malformed signature/key/input so callers can
 * treat any failure uniformly as "auth failed" without a try/catch.
 */
export function verifyChallenge(
	publicKey: string,
	signature: string,
	nonce: string,
	timestamp: number,
): boolean {
	try {
		const message = utf8ToBytes(canonicalChallengePayload(nonce, timestamp))
		return ed25519.verify(hexToBytes(signature), message, hexToBytes(publicKey))
	} catch {
		return false
	}
}

/**
 * Issues a device certificate: vaerksted-auth (the "CA") signs
 * `{device_id, identity_id, public_key, expires_at}` with its own signing
 * private key — distinct from any device's own keypair. This is design doc
 * §6 step 3's `POST /devices` response payload.
 */
export function issueCert(
	params: { deviceId: string; identityId: string; publicKey: string; expiresAt: Date },
	signingPrivateKey: string,
): DeviceCert {
	const payload: CertPayload = {
		device_id: params.deviceId,
		identity_id: params.identityId,
		public_key: params.publicKey,
		expires_at: params.expiresAt.toISOString(),
	}
	const message = utf8ToBytes(canonicalCertPayload(payload))
	const signature = ed25519.sign(message, hexToBytes(signingPrivateKey))
	return { ...payload, signature: bytesToHex(signature) }
}

/**
 * Verifies a device cert's signature against vaerksted-auth's known public
 * signing key. Does NOT check `expires_at` against the current time — see
 * this module's top-of-file doc comment for why expiry-checking is left to
 * the caller.
 */
export function verifyCert(cert: DeviceCert, authPublicKey: string): boolean {
	try {
		const message = utf8ToBytes(canonicalCertPayload(cert))
		return ed25519.verify(hexToBytes(cert.signature), message, hexToBytes(authPublicKey))
	} catch {
		return false
	}
}
