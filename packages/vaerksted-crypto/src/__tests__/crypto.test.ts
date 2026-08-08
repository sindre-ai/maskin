import { describe, expect, it } from 'vitest'
import { generateKeypair, issueCert, signChallenge, verifyCert, verifyChallenge } from '../index'

describe('generateKeypair', () => {
	it('round-trips: a message signed with the private key verifies against the public key', () => {
		const { publicKey, privateKey } = generateKeypair()
		const signature = signChallenge(privateKey, 'nonce-1', 1000)
		expect(verifyChallenge(publicKey, signature, 'nonce-1', 1000)).toBe(true)
	})

	it('produces distinct keypairs on each call', () => {
		const a = generateKeypair()
		const b = generateKeypair()
		expect(a.publicKey).not.toBe(b.publicKey)
		expect(a.privateKey).not.toBe(b.privateKey)
	})

	it('produces lowercase hex-encoded keys', () => {
		const { publicKey, privateKey } = generateKeypair()
		expect(publicKey).toMatch(/^[0-9a-f]+$/)
		expect(privateKey).toMatch(/^[0-9a-f]+$/)
	})
})

describe('signChallenge / verifyChallenge', () => {
	it('verifies a valid signature as true', () => {
		const { publicKey, privateKey } = generateKeypair()
		const signature = signChallenge(privateKey, 'abc123', 1_700_000_000)
		expect(verifyChallenge(publicKey, signature, 'abc123', 1_700_000_000)).toBe(true)
	})

	it('rejects a tampered nonce', () => {
		const { publicKey, privateKey } = generateKeypair()
		const signature = signChallenge(privateKey, 'abc123', 1_700_000_000)
		expect(verifyChallenge(publicKey, signature, 'tampered-nonce', 1_700_000_000)).toBe(false)
	})

	it('rejects a tampered timestamp', () => {
		const { publicKey, privateKey } = generateKeypair()
		const signature = signChallenge(privateKey, 'abc123', 1_700_000_000)
		expect(verifyChallenge(publicKey, signature, 'abc123', 1_700_000_001)).toBe(false)
	})

	it('rejects a signature from a different keypair', () => {
		const a = generateKeypair()
		const b = generateKeypair()
		const signature = signChallenge(a.privateKey, 'abc123', 1_700_000_000)
		expect(verifyChallenge(b.publicKey, signature, 'abc123', 1_700_000_000)).toBe(false)
	})

	it('rejects a malformed signature without throwing', () => {
		const { publicKey } = generateKeypair()
		expect(verifyChallenge(publicKey, 'not-hex-!!', 'abc123', 1_700_000_000)).toBe(false)
	})
})

describe('issueCert / verifyCert', () => {
	it('round-trips: a cert issued with the CA private key verifies against the CA public key', () => {
		const ca = generateKeypair()
		const device = generateKeypair()
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

		const cert = issueCert(
			{
				deviceId: 'device-1',
				identityId: 'identity-1',
				publicKey: device.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)

		expect(cert.device_id).toBe('device-1')
		expect(cert.identity_id).toBe('identity-1')
		expect(cert.public_key).toBe(device.publicKey)
		expect(cert.expires_at).toBe(expiresAt.toISOString())
		expect(verifyCert(cert, ca.publicKey)).toBe(true)
	})

	it('rejects a cert whose payload was tampered with after issuance', () => {
		const ca = generateKeypair()
		const device = generateKeypair()
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

		const cert = issueCert(
			{
				deviceId: 'device-1',
				identityId: 'identity-1',
				publicKey: device.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)

		const tampered = { ...cert, identity_id: 'attacker-identity' }
		expect(verifyCert(tampered, ca.publicKey)).toBe(false)
	})

	it('rejects a cert signed by a different (non-CA) key', () => {
		const ca = generateKeypair()
		const impostor = generateKeypair()
		const device = generateKeypair()
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

		const cert = issueCert(
			{
				deviceId: 'device-1',
				identityId: 'identity-1',
				publicKey: device.publicKey,
				expiresAt,
			},
			impostor.privateKey,
		)

		expect(verifyCert(cert, ca.publicKey)).toBe(false)
	})

	it('signature-verifies an already-expired cert as true — expiry is the caller responsibility, not this library', () => {
		const ca = generateKeypair()
		const device = generateKeypair()
		const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24h in the past

		const cert = issueCert(
			{
				deviceId: 'device-1',
				identityId: 'identity-1',
				publicKey: device.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)

		// The signature itself is genuine, so verifyCert reports true...
		expect(verifyCert(cert, ca.publicKey)).toBe(true)
		// ...but the caller must separately check expiry before trusting it.
		expect(new Date(cert.expires_at).getTime()).toBeLessThan(Date.now())
	})
})
