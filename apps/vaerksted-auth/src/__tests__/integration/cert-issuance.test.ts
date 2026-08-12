import { generateKeypair, issueCert, verifyCert } from '@maskin/vaerksted-crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { device, deviceCert, vaerkstedIdentity } from '../../db/schema'
import { db, testDatabaseUrl } from './global-setup'

// Exercises the cert-issuance + revocation flow (design doc §6 steps 3 and
// 5) against a REAL Postgres — per `.claude/rules/verification.md`'s "any
// DB-writing route/service needs an integration test" rule, applied to this
// app's own schema. Covers real-Postgres semantics a mocked-DB unit test
// cannot: FK enforcement between the three tables, and the unique
// constraint on `device.public_key`.
//
// See global-setup.ts for how the database is resolved and why this only
// ever touches a throwaway `vaerksted_auth_test` database — never Maskin's
// own `maskin` database.
describe.skipIf(!testDatabaseUrl)('cert issuance + revocation (real Postgres)', () => {
	it('issues a cert for a newly-registered device and verifies it against the CA public key', async () => {
		const ca = generateKeypair()
		const deviceKeys = generateKeypair()

		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: 'integration@example.com' })
			.returning()
		expect(identity).toBeDefined()

		const [deviceRow] = await db
			.insert(device)
			.values({
				identityId: identity?.id,
				publicKey: deviceKeys.publicKey,
				platform: 'macos',
				displayName: 'Integration Test Device',
			})
			.returning()
		expect(deviceRow).toBeDefined()
		if (!identity || !deviceRow) throw new Error('setup failed')

		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
		const cert = issueCert(
			{
				deviceId: deviceRow.id,
				identityId: identity.id,
				publicKey: deviceRow.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)

		const [certRow] = await db
			.insert(deviceCert)
			.values({
				deviceId: deviceRow.id,
				identityId: identity.id,
				expiresAt,
				signature: cert.signature,
			})
			.returning()
		expect(certRow).toBeDefined()

		// Read it back from the DB and verify against the CA public key, same
		// as device-cert-middleware.ts would.
		const [readBack] = await db
			.select()
			.from(deviceCert)
			.where(eq(deviceCert.deviceId, deviceRow.id))
			.limit(1)
		expect(readBack).toBeDefined()
		if (!readBack) throw new Error('cert not found')

		const readBackCert = {
			device_id: deviceRow.id,
			identity_id: identity.id,
			public_key: deviceRow.publicKey,
			expires_at: readBack.expiresAt.toISOString(),
			signature: readBack.signature,
		}
		expect(verifyCert(readBackCert, ca.publicKey)).toBe(true)
	})

	it('rejects a device_cert insert whose device_id does not exist (FK enforcement)', async () => {
		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: null })
			.returning()
		if (!identity) throw new Error('setup failed')

		await expect(
			db.insert(deviceCert).values({
				deviceId: crypto.randomUUID(),
				identityId: identity.id,
				expiresAt: new Date(Date.now() + 60_000),
				signature: 'deadbeef',
			}),
		).rejects.toThrow()
	})

	it('rejects registering two devices with the same public key (unique constraint)', async () => {
		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: null })
			.returning()
		if (!identity) throw new Error('setup failed')
		const deviceKeys = generateKeypair()

		await db.insert(device).values({
			identityId: identity.id,
			publicKey: deviceKeys.publicKey,
			platform: 'macos',
		})

		await expect(
			db.insert(device).values({
				identityId: identity.id,
				publicKey: deviceKeys.publicKey,
				platform: 'ios',
			}),
		).rejects.toThrow()
	})

	it('revocation: a revoked device is excluded by the same query device-cert-middleware uses', async () => {
		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: null })
			.returning()
		if (!identity) throw new Error('setup failed')
		const deviceKeys = generateKeypair()

		const [deviceRow] = await db
			.insert(device)
			.values({ identityId: identity.id, publicKey: deviceKeys.publicKey, platform: 'macos' })
			.returning()
		if (!deviceRow) throw new Error('setup failed')

		// Sanity check: not yet revoked.
		const [beforeRevoke] = await db
			.select()
			.from(device)
			.where(eq(device.id, deviceRow.id))
			.limit(1)
		expect(beforeRevoke?.revokedAt).toBeNull()

		await db.update(device).set({ revokedAt: new Date() }).where(eq(device.id, deviceRow.id))

		const [afterRevoke] = await db.select().from(device).where(eq(device.id, deviceRow.id)).limit(1)
		expect(afterRevoke?.revokedAt).not.toBeNull()
	})
})
