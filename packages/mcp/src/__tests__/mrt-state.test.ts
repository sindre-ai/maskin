import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	MrtStateExpiredError,
	MrtStateMismatchError,
	MrtStateOpenError,
	MrtStateShapeError,
	type RequestStateInput,
	hashArgs,
	loadSealKeys,
	openRequestState,
	sealRequestState,
} from '../lib/mrt-state'

const CURRENT_KEY = randomBytes(32)
const PREVIOUS_KEY = randomBytes(32)
const OTHER_KEY = randomBytes(32)

const KEYS_CURRENT_ONLY = { current: CURRENT_KEY }
const KEYS_WITH_PREVIOUS = { current: CURRENT_KEY, previous: PREVIOUS_KEY }

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const TTL_MS = 24 * 60 * 60 * 1000

function samplePayload(overrides: Partial<RequestStateInput> = {}): RequestStateInput {
	return {
		principalActorId: 'actor-alice',
		workspaceId: 'ws-nordics',
		objectId: 'obj-42',
		toolName: 'request_human_approval',
		argsDigest: hashArgs({ question: 'ship it?' }),
		auditCommentEventId: '12345',
		exp: T0 + TTL_MS,
		...overrides,
	}
}

function expectedFrom(payload: RequestStateInput, now = T0) {
	return {
		caller: payload.principalActorId,
		workspaceId: payload.workspaceId,
		toolName: payload.toolName,
		argsDigest: payload.argsDigest,
		now,
	}
}

describe('sealRequestState / openRequestState', () => {
	describe('round-trip', () => {
		it('opens what it sealed, verifies every bound field, returns the payload', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			expect(typeof blob).toBe('string')
			expect(blob).toMatch(/^[A-Za-z0-9_-]+$/)

			const payload = openRequestState(blob, expectedFrom(input), KEYS_CURRENT_ONLY)
			expect(payload.v).toBe(1)
			expect(payload.principalActorId).toBe(input.principalActorId)
			expect(payload.workspaceId).toBe(input.workspaceId)
			expect(payload.objectId).toBe(input.objectId)
			expect(payload.toolName).toBe(input.toolName)
			expect(payload.argsDigest).toBe(input.argsDigest)
			expect(payload.auditCommentEventId).toBe(input.auditCommentEventId)
			expect(payload.exp).toBe(input.exp)
			expect(typeof payload.nonce).toBe('string')
			expect(payload.nonce.length).toBeGreaterThan(0)
		})

		it('generates a fresh nonce and IV on every seal (same input → distinct blobs)', () => {
			const input = samplePayload()
			const a = sealRequestState(input, KEYS_CURRENT_ONLY)
			const b = sealRequestState(input, KEYS_CURRENT_ONLY)
			expect(a).not.toBe(b)
		})
	})

	describe('tampering', () => {
		it('rejects a blob with a flipped byte in the ciphertext', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			const raw = Buffer.from(blob, 'base64url')
			// Flip a byte inside the ciphertext region (past the 12-byte IV, before the 16-byte tag).
			const flipIdx = 12 + Math.floor((raw.length - 12 - 16) / 2)
			raw.writeUInt8(raw.readUInt8(flipIdx) ^ 0x01, flipIdx)
			const tampered = raw.toString('base64url')

			expect(() => openRequestState(tampered, expectedFrom(input), KEYS_CURRENT_ONLY)).toThrow(
				MrtStateOpenError,
			)
		})

		it('rejects a blob with a flipped byte in the auth tag', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			const raw = Buffer.from(blob, 'base64url')
			const tagIdx = raw.length - 1
			raw.writeUInt8(raw.readUInt8(tagIdx) ^ 0x80, tagIdx)
			const tampered = raw.toString('base64url')

			expect(() => openRequestState(tampered, expectedFrom(input), KEYS_CURRENT_ONLY)).toThrow(
				MrtStateOpenError,
			)
		})

		it('rejects a truncated blob', () => {
			expect(() =>
				openRequestState('AAAA', expectedFrom(samplePayload()), KEYS_CURRENT_ONLY),
			).toThrow(MrtStateOpenError)
		})

		it('rejects a blob signed by an unknown key', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, { current: OTHER_KEY })
			expect(() => openRequestState(blob, expectedFrom(input), KEYS_CURRENT_ONLY)).toThrow(
				MrtStateOpenError,
			)
		})
	})

	describe('binding mismatch', () => {
		it('rejects when the caller principal does not match', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			try {
				openRequestState(
					blob,
					{ ...expectedFrom(input), caller: 'actor-mallory' },
					KEYS_CURRENT_ONLY,
				)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateMismatchError)
				expect((err as MrtStateMismatchError).field).toBe('principalActorId')
			}
		})

		it('rejects when the workspace does not match', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			try {
				openRequestState(
					blob,
					{ ...expectedFrom(input), workspaceId: 'ws-other' },
					KEYS_CURRENT_ONLY,
				)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateMismatchError)
				expect((err as MrtStateMismatchError).field).toBe('workspaceId')
			}
		})

		it('rejects when the tool name does not match', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			try {
				openRequestState(
					blob,
					{ ...expectedFrom(input), toolName: 'delete_workspace' },
					KEYS_CURRENT_ONLY,
				)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateMismatchError)
				expect((err as MrtStateMismatchError).field).toBe('toolName')
			}
		})

		it('rejects when the argsDigest does not match', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			try {
				openRequestState(
					blob,
					{ ...expectedFrom(input), argsDigest: hashArgs({ question: 'different?' }) },
					KEYS_CURRENT_ONLY,
				)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateMismatchError)
				expect((err as MrtStateMismatchError).field).toBe('argsDigest')
			}
		})

		it('verifies bound fields in order: principal before workspace before tool before args', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			// All four wrong at once — should surface the FIRST failing field.
			try {
				openRequestState(
					blob,
					{
						caller: 'x',
						workspaceId: 'x',
						toolName: 'x',
						argsDigest: 'x',
						now: T0,
					},
					KEYS_CURRENT_ONLY,
				)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateMismatchError)
				expect((err as MrtStateMismatchError).field).toBe('principalActorId')
			}
		})
	})

	describe('expiry', () => {
		it('rejects a token whose exp is in the past', () => {
			const input = samplePayload({ exp: T0 - 1 })
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			try {
				openRequestState(blob, expectedFrom(input, T0), KEYS_CURRENT_ONLY)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateExpiredError)
				expect((err as MrtStateExpiredError).exp).toBe(input.exp)
				expect((err as MrtStateExpiredError).now).toBe(T0)
			}
		})

		it('rejects a token whose exp equals now (boundary — treat as expired)', () => {
			const input = samplePayload({ exp: T0 })
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			expect(() => openRequestState(blob, expectedFrom(input, T0), KEYS_CURRENT_ONLY)).toThrow(
				MrtStateExpiredError,
			)
		})

		it('accepts a token whose exp is one ms in the future', () => {
			const input = samplePayload({ exp: T0 + 1 })
			const blob = sealRequestState(input, KEYS_CURRENT_ONLY)
			expect(() => openRequestState(blob, expectedFrom(input, T0), KEYS_CURRENT_ONLY)).not.toThrow()
		})
	})

	describe('key rotation', () => {
		it('decodes a blob signed by the previous key when it is registered', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, { current: PREVIOUS_KEY })
			const payload = openRequestState(blob, expectedFrom(input), KEYS_WITH_PREVIOUS)
			expect(payload.principalActorId).toBe(input.principalActorId)
		})

		it('still decodes blobs signed by the current key when a previous key is registered', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_WITH_PREVIOUS)
			const payload = openRequestState(blob, expectedFrom(input), KEYS_WITH_PREVIOUS)
			expect(payload.principalActorId).toBe(input.principalActorId)
		})

		it('signs with the current key, not the previous key', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, KEYS_WITH_PREVIOUS)
			// If it signed with the current key, opening with previous-only should fail.
			expect(() => openRequestState(blob, expectedFrom(input), { current: PREVIOUS_KEY })).toThrow(
				MrtStateOpenError,
			)
		})

		it('rejects a blob signed by neither the current nor the previous key', () => {
			const input = samplePayload()
			const blob = sealRequestState(input, { current: OTHER_KEY })
			expect(() => openRequestState(blob, expectedFrom(input), KEYS_WITH_PREVIOUS)).toThrow(
				MrtStateOpenError,
			)
		})
	})

	describe('shape validation', () => {
		it('throws MrtStateShapeError (which is an MrtStateOpenError) when plaintext is not the expected shape', () => {
			// Craft a valid AEAD-sealed blob whose plaintext is JSON but not a RequestStatePayload.
			const iv = randomBytes(12)
			const cipher = createCipheriv('aes-256-gcm', CURRENT_KEY, iv)
			cipher.setAAD(Buffer.from('mrt-v1', 'utf8'))
			const ct = Buffer.concat([
				cipher.update(Buffer.from('{"hello":"world"}', 'utf8')),
				cipher.final(),
			])
			const tag = cipher.getAuthTag()
			const blob = Buffer.concat([iv, ct, tag]).toString('base64url')

			try {
				openRequestState(blob, expectedFrom(samplePayload()), KEYS_CURRENT_ONLY)
				throw new Error('expected throw')
			} catch (err) {
				expect(err).toBeInstanceOf(MrtStateShapeError)
				expect(err).toBeInstanceOf(MrtStateOpenError)
			}
		})
	})
})

describe('hashArgs', () => {
	it('is stable across key ordering', () => {
		expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }))
	})

	it('is sensitive to value changes', () => {
		expect(hashArgs({ q: 'ship?' })).not.toBe(hashArgs({ q: 'ship!' }))
	})

	it('handles nested objects and arrays deterministically', () => {
		expect(hashArgs({ x: [1, 2, { a: 1, b: 2 }] })).toBe(hashArgs({ x: [1, 2, { b: 2, a: 1 }] }))
	})
})

describe('loadSealKeys', () => {
	beforeEach(() => {
		vi.unstubAllEnvs()
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('reads the current key from ELICITATION_SEAL_KEY (base64, 32 bytes)', () => {
		vi.stubEnv('ELICITATION_SEAL_KEY', CURRENT_KEY.toString('base64'))
		const keys = loadSealKeys()
		expect(keys.current.equals(CURRENT_KEY)).toBe(true)
		expect(keys.previous).toBeUndefined()
	})

	it('reads a rotation-window previous key from ELICITATION_SEAL_KEY_PREVIOUS', () => {
		vi.stubEnv('ELICITATION_SEAL_KEY', CURRENT_KEY.toString('base64'))
		vi.stubEnv('ELICITATION_SEAL_KEY_PREVIOUS', PREVIOUS_KEY.toString('base64'))
		const keys = loadSealKeys()
		expect(keys.current.equals(CURRENT_KEY)).toBe(true)
		expect(keys.previous?.equals(PREVIOUS_KEY)).toBe(true)
	})

	it('throws when ELICITATION_SEAL_KEY is missing', () => {
		vi.stubEnv('ELICITATION_SEAL_KEY', '')
		expect(() => loadSealKeys()).toThrow(/ELICITATION_SEAL_KEY/)
	})

	it('throws when the key does not decode to 32 bytes', () => {
		vi.stubEnv('ELICITATION_SEAL_KEY', Buffer.from('too-short').toString('base64'))
		expect(() => loadSealKeys()).toThrow(/32 bytes/)
	})

	it('accepts an empty ELICITATION_SEAL_KEY_PREVIOUS as "no rotation"', () => {
		vi.stubEnv('ELICITATION_SEAL_KEY', CURRENT_KEY.toString('base64'))
		vi.stubEnv('ELICITATION_SEAL_KEY_PREVIOUS', '')
		const keys = loadSealKeys()
		expect(keys.previous).toBeUndefined()
	})
})
