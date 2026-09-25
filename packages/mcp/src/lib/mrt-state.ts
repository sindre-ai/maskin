/**
 * Sealed `requestState` codec for the MCP Multi Round-Trip Requests
 * (SEP-2322) elicitation flow.
 *
 * The Maskin MCP surface is stateless — each `tools/call` runs against a
 * fresh HTTP request with no per-connection server state. To resume an
 * elicitation on retry, the server hands the client an opaque, AEAD-sealed
 * blob that carries everything needed to reconstruct the pending call
 * safely. On retry, the server opens the blob and verifies the caller,
 * workspace, tool, argsDigest and expiry match the incoming call before
 * accepting the human's answer.
 *
 * This module is deliberately pure: no DB, no MCP SDK imports. See
 * tech-spec-mrt-approval-flow.md §3 for the rationale (DB-backed
 * resumption was explicitly rejected).
 */

import {
	type CipherGCM,
	type DecipherGCM,
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto'

const AAD = Buffer.from('mrt-v1', 'utf8')
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const NONCE_BYTES = 16

/**
 * Payload sealed inside a `requestState` blob. Shape locked by
 * tech-spec-mrt-approval-flow.md §3. Bump `v` on any field change.
 */
export interface RequestStatePayload {
	v: 1
	principalActorId: string
	workspaceId: string
	objectId: string
	toolName: string
	argsDigest: string
	auditCommentEventId: string
	exp: number
	nonce: string
}

/**
 * The subset of the payload a caller supplies. `nonce` is filled by the
 * codec so callers can't accidentally reuse one, and `v` is fixed.
 */
export type RequestStateInput = Omit<RequestStatePayload, 'v' | 'nonce'>

export interface OpenExpectations {
	caller: string
	workspaceId: string
	toolName: string
	argsDigest: string
	/** Override `Date.now()` — used only by tests. */
	now?: number
}

export interface SealKeys {
	current: Buffer
	previous?: Buffer
}

/**
 * AEAD decrypt failed — the blob was tampered with, truncated, encoded
 * wrong, or signed by a key we no longer accept. Handler should map to
 * JSON-RPC `-32602 InvalidParams` (terminal).
 */
export class MrtStateOpenError extends Error {
	readonly code = 'MRT_STATE_OPEN_FAILED' as const
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'MrtStateOpenError'
	}
}

/**
 * AEAD open succeeded but a bound field didn't match the incoming call —
 * cross-user, cross-tool, cross-workspace, or cross-args replay. Handler
 * should map to `-32602 InvalidParams` (terminal).
 */
export class MrtStateMismatchError extends Error {
	readonly code = 'MRT_STATE_MISMATCH' as const
	readonly field: 'principalActorId' | 'workspaceId' | 'toolName' | 'argsDigest'
	constructor(field: MrtStateMismatchError['field']) {
		super(`requestState ${field} does not match the incoming call`)
		this.name = 'MrtStateMismatchError'
		this.field = field
	}
}

/**
 * Token TTL elapsed. Handler should return a terminal `isError` result
 * telling the caller to recall the tool to re-ask the human — the
 * elicitation cannot be resumed.
 */
export class MrtStateExpiredError extends Error {
	readonly code = 'MRT_STATE_EXPIRED' as const
	readonly exp: number
	readonly now: number
	constructor(exp: number, now: number) {
		super(
			`requestState expired at ${new Date(exp).toISOString()} (now ${new Date(now).toISOString()})`,
		)
		this.name = 'MrtStateExpiredError'
		this.exp = exp
		this.now = now
	}
}

/**
 * Structured shape error — the sealed blob decrypted to something that
 * isn't a valid `RequestStatePayload`. Treated like an open failure by
 * the handler (terminal InvalidParams).
 */
export class MrtStateShapeError extends MrtStateOpenError {
	constructor(message: string) {
		super(message)
		this.name = 'MrtStateShapeError'
	}
}

/**
 * Load the AES-256 key(s) from the environment. Rotation is additive:
 * `ELICITATION_SEAL_KEY` is the current signer; the optional
 * `ELICITATION_SEAL_KEY_PREVIOUS` is accepted on decrypt for the TTL
 * window while old blobs age out.
 *
 * Both variables are base64-encoded 32-byte keys. This module never
 * touches secret provisioning — see the package README.
 */
export function loadSealKeys(env: NodeJS.ProcessEnv = process.env): SealKeys {
	const current = decodeKey(env.ELICITATION_SEAL_KEY, 'ELICITATION_SEAL_KEY')
	const previousRaw = env.ELICITATION_SEAL_KEY_PREVIOUS
	const previous =
		previousRaw && previousRaw.length > 0
			? decodeKey(previousRaw, 'ELICITATION_SEAL_KEY_PREVIOUS')
			: undefined
	return { current, previous }
}

function decodeKey(raw: string | undefined, varName: string): Buffer {
	if (!raw) {
		throw new Error(`${varName} is required (base64-encoded 32 bytes)`)
	}
	const buf = Buffer.from(raw, 'base64')
	if (buf.length !== KEY_BYTES) {
		throw new Error(`${varName} must decode to ${KEY_BYTES} bytes, got ${buf.length}`)
	}
	return buf
}

/**
 * Compute the argsDigest bound into the sealed blob. Uses a stable JSON
 * canonicalisation (object keys sorted) so semantically equal args hash
 * the same across retries.
 */
export function hashArgs(args: unknown): string {
	const canonical = canonicalJson(args)
	return createHash('sha256').update(canonical).digest('hex')
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`
	}
	const keys = Object.keys(value as Record<string, unknown>).sort()
	const parts = keys.map(
		(k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
	)
	return `{${parts.join(',')}}`
}

/**
 * Seal a request-state payload with the current key, returning a
 * base64url blob suitable for the `requestState` field on an
 * `input_required` MRT response.
 *
 * Blob layout: `iv (12) || ciphertext || tag (16)`, AAD = "mrt-v1".
 */
export function sealRequestState(
	input: RequestStateInput,
	keys: SealKeys = loadSealKeys(),
): string {
	const payload: RequestStatePayload = {
		v: 1,
		...input,
		nonce: randomBytes(NONCE_BYTES).toString('base64'),
	}
	const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
	const iv = randomBytes(IV_BYTES)
	const cipher: CipherGCM = createCipheriv(ALGORITHM, keys.current, iv)
	cipher.setAAD(AAD)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const tag = cipher.getAuthTag()
	return Buffer.concat([iv, ciphertext, tag]).toString('base64url')
}

/**
 * Verify and open a sealed `requestState` blob against the incoming
 * `tools/call`. Throws one of {@link MrtStateOpenError},
 * {@link MrtStateMismatchError}, {@link MrtStateExpiredError} so the
 * handler can distinguish tamper-vs-mismatch-vs-expired.
 *
 * Verification order (matches spec §3): AEAD open → principalActorId →
 * workspaceId → toolName → argsDigest → exp.
 */
export function openRequestState(
	blob: string,
	expected: OpenExpectations,
	keys: SealKeys = loadSealKeys(),
): RequestStatePayload {
	const payload = decrypt(blob, keys)

	if (!matches(payload.principalActorId, expected.caller)) {
		throw new MrtStateMismatchError('principalActorId')
	}
	if (!matches(payload.workspaceId, expected.workspaceId)) {
		throw new MrtStateMismatchError('workspaceId')
	}
	if (!matches(payload.toolName, expected.toolName)) {
		throw new MrtStateMismatchError('toolName')
	}
	if (!matches(payload.argsDigest, expected.argsDigest)) {
		throw new MrtStateMismatchError('argsDigest')
	}

	const now = expected.now ?? Date.now()
	if (payload.exp <= now) {
		throw new MrtStateExpiredError(payload.exp, now)
	}
	return payload
}

function decrypt(blob: string, keys: SealKeys): RequestStatePayload {
	let raw: Buffer
	try {
		raw = Buffer.from(blob, 'base64url')
	} catch (cause) {
		throw new MrtStateOpenError('requestState is not valid base64url', { cause })
	}
	if (raw.length < IV_BYTES + TAG_BYTES + 1) {
		throw new MrtStateOpenError('requestState is truncated')
	}
	const iv = raw.subarray(0, IV_BYTES)
	const tag = raw.subarray(raw.length - TAG_BYTES)
	const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)

	const candidateKeys = keys.previous ? [keys.current, keys.previous] : [keys.current]
	let lastError: unknown
	for (const key of candidateKeys) {
		try {
			const plaintext = decryptWithKey(key, iv, ciphertext, tag)
			return parsePayload(plaintext)
		} catch (err) {
			// If shape/parse failed, treat as terminal — no other key will help.
			if (err instanceof MrtStateShapeError) throw err
			lastError = err
		}
	}
	throw new MrtStateOpenError('requestState AEAD open failed', { cause: lastError })
}

function decryptWithKey(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
	const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key, iv)
	decipher.setAAD(AAD)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function parsePayload(plaintext: Buffer): RequestStatePayload {
	let parsed: unknown
	try {
		parsed = JSON.parse(plaintext.toString('utf8'))
	} catch {
		throw new MrtStateShapeError('requestState plaintext is not JSON')
	}
	if (!isRequestStatePayload(parsed)) {
		throw new MrtStateShapeError('requestState payload has unexpected shape')
	}
	return parsed
}

function isRequestStatePayload(v: unknown): v is RequestStatePayload {
	if (v === null || typeof v !== 'object') return false
	const p = v as Record<string, unknown>
	return (
		p.v === 1 &&
		typeof p.principalActorId === 'string' &&
		typeof p.workspaceId === 'string' &&
		typeof p.objectId === 'string' &&
		typeof p.toolName === 'string' &&
		typeof p.argsDigest === 'string' &&
		typeof p.auditCommentEventId === 'string' &&
		typeof p.exp === 'number' &&
		Number.isFinite(p.exp) &&
		typeof p.nonce === 'string'
	)
}

/**
 * Constant-time string compare — prevents timing side-channels when
 * comparing caller/workspace/tool ids and args digests.
 */
function matches(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8')
	const bb = Buffer.from(b, 'utf8')
	if (ab.length !== bb.length) return false
	return timingSafeEqual(ab, bb)
}
