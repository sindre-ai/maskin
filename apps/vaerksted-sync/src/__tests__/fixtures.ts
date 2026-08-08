import { randomBytes, randomUUID } from 'node:crypto'
import {
	type DeviceCert,
	type Keypair,
	generateKeypair,
	issueCert,
	signChallenge,
} from '@maskin/vaerksted-crypto'

/**
 * A full device-cert auth fixture: a fake "CA" keypair (standing in for
 * vaerksted-auth's own signing key), a device keypair, and a cert issued by
 * the CA for that device — everything device-cert-middleware.ts needs to
 * verify a request as coming from a real, unexpired, non-replayed device.
 */
export type AuthFixture = {
	ca: Keypair
	deviceKeys: Keypair
	deviceId: string
	identityId: string
	cert: DeviceCert
}

export function buildAuthFixture(
	overrides: { expiresAt?: Date; ca?: Keypair; identityId?: string } = {},
): AuthFixture {
	// Allow callers to share a CA and/or identityId across multiple fixtures —
	// e.g. simulating two devices belonging to the same vaerksted identity,
	// both certified by the same CA (see the WS fan-out test).
	const ca = overrides.ca ?? generateKeypair()
	const deviceKeys = generateKeypair()
	const deviceId = randomUUID()
	const identityId = overrides.identityId ?? randomUUID()
	const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
	const cert = issueCert(
		{ deviceId, identityId, publicKey: deviceKeys.publicKey, expiresAt },
		ca.privateKey,
	)
	return { ca, deviceKeys, deviceId, identityId, cert }
}

/** Builds the X-Device-Cert/X-Nonce/X-Timestamp/X-Signature header set for a request. */
export function buildAuthHeaders(
	fixture: AuthFixture,
	overrides: { nonce?: string; timestamp?: number } = {},
): Record<string, string> {
	const nonce = overrides.nonce ?? randomBytes(16).toString('hex')
	const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000)
	const signature = signChallenge(fixture.deviceKeys.privateKey, nonce, timestamp)
	return {
		'X-Device-Cert': JSON.stringify(fixture.cert),
		'X-Nonce': nonce,
		'X-Timestamp': String(timestamp),
		'X-Signature': signature,
	}
}
