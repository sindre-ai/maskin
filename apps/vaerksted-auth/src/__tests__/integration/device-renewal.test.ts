import { generateKeypair } from '@maskin/vaerksted-crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { device, vaerkstedIdentity } from '../../db/schema'
import { buildApp } from '../../index'
import { issueSessionToken } from '../../lib/session-token'
import { db, testDatabaseUrl } from './global-setup'

// Real-Postgres regression test for the cert-renewal bug the M3 (Skjald)
// implementation pass surfaced: a device's public key never changes across
// its lifetime, so calling POST /devices again with the same key — which is
// exactly what cert renewal does — used to hit `device.public_key`'s unique
// constraint and 409 forever. Fixed in routes/devices.ts by looking the
// device up by public_key first and reissuing a cert instead of inserting a
// duplicate row. This test exercises the real route handler against real
// Postgres (not the mocked-DB unit tests in __tests__/routes/devices.test.ts)
// specifically because the bug was a DB-semantics issue (unique constraint
// interaction), which is exactly what a mocked DB cannot catch — see
// .claude/rules/verification.md.
describe.skipIf(!testDatabaseUrl)('POST /devices — cert renewal (real Postgres)', () => {
	const env = {
		PORT: 3001 as const,
		VAERKSTED_AUTH_DATABASE_URL: 'unused-in-this-test',
		SUPABASE_URL: 'https://test.supabase.co',
		SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
		VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: generateKeypair().privateKey,
		VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: undefined as string | undefined,
		VAERKSTED_AUTH_SESSION_JWT_SECRET: 'test-session-secret-at-least-16-chars',
	}

	async function registerOnce(publicKey: string, identityId: string) {
		const app = buildApp(env, db)
		const token = await issueSessionToken(identityId, env.VAERKSTED_AUTH_SESSION_JWT_SECRET)
		return app.request('/devices', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: publicKey, platform: 'macos' }),
		})
	}

	it('second registration of the same public key reissues (200) instead of 409ing, and does not create a duplicate device row', async () => {
		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: 'renewal@example.com' })
			.returning()
		if (!identity) throw new Error('setup failed')
		const deviceKeys = generateKeypair()

		const first = await registerOnce(deviceKeys.publicKey, identity.id)
		expect(first.status).toBe(201)
		const firstBody = await first.json()

		const second = await registerOnce(deviceKeys.publicKey, identity.id)
		expect(second.status).toBe(200)
		const secondBody = await second.json()

		expect(secondBody.device_id).toBe(firstBody.device_id)
		// A genuinely fresh cert, not the same row replayed.
		expect(secondBody.signature).not.toBe(firstBody.signature)

		const rows = await db.select().from(device).where(eq(device.publicKey, deviceKeys.publicKey))
		expect(rows).toHaveLength(1)
	})

	it('a revoked device gets 403 on renewal, never a silently reissued cert', async () => {
		const [identity] = await db
			.insert(vaerkstedIdentity)
			.values({ supabaseUserId: crypto.randomUUID(), email: 'revoked-renewal@example.com' })
			.returning()
		if (!identity) throw new Error('setup failed')
		const deviceKeys = generateKeypair()

		const first = await registerOnce(deviceKeys.publicKey, identity.id)
		expect(first.status).toBe(201)
		const { device_id: deviceId } = await first.json()

		await db.update(device).set({ revokedAt: new Date() }).where(eq(device.id, deviceId))

		const renewal = await registerOnce(deviceKeys.publicKey, identity.id)
		expect(renewal.status).toBe(403)
	})
})
