import { issueCert } from '@maskin/vaerksted-crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { device, deviceCert } from '../db/schema'
import { sessionMiddleware } from '../lib/session-middleware'
import { sessionOrDeviceCertMiddleware } from '../lib/session-or-device-cert-middleware'
import type { AppEnv } from '../types'

// Design doc §6: "24h" proposal for device-cert TTL (§12 flags this as a
// placeholder open question — shorter improves revocation propagation
// speed, longer reduces re-auth chatter for offline-heavy Skjald usage).
const DEVICE_CERT_TTL_MS = 24 * 60 * 60 * 1000

const registerDeviceBodySchema = z.object({
	public_key: z.string().min(1),
	platform: z.string().min(1),
	display_name: z.string().optional(),
})

export const devicesRoute = new Hono<AppEnv>()

// POST /devices — session-authenticated (design doc §6 step 3: "authenticated
// by the session from step 2, the device sends its public key"). Registers
// the device and issues its first cert.
devicesRoute.post('/devices', sessionMiddleware(), async (c) => {
	const env = c.get('env')
	const db = c.get('db')
	const identityId = c.get('identityId')
	if (!identityId) {
		// Unreachable in practice — sessionMiddleware always sets identityId
		// before calling next() — but keeps this handler type-safe and fails
		// loudly instead of silently writing a null identity_id if that
		// invariant is ever broken by a future middleware change.
		return c.json({ error: 'unauthorized' }, 401)
	}

	if (!env.VAERKSTED_AUTH_SIGNING_PRIVATE_KEY) {
		return c.json(
			{ error: 'server_misconfigured', message: 'VAERKSTED_AUTH_SIGNING_PRIVATE_KEY not set' },
			503,
		)
	}

	let body: z.infer<typeof registerDeviceBodySchema>
	try {
		const parsed = registerDeviceBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400)
		}
		body = parsed.data
	} catch {
		return c.json({ error: 'invalid_json' }, 400)
	}

	// TODO(MFA step-up): design doc §6a — "issuing a *new* device certificate
	// ... should require a fresh MFA check regardless of whether the session
	// that authorized it already had one, the same way most products ask for
	// step-up auth before adding a payment method." MFA doesn't exist yet
	// (explicitly "Later" in §6a's priority order) — this is the hook point
	// for that check once it does. No-op for now: any valid session may
	// register a device.

	// A device's public key never changes across its lifetime (it's the
	// device's identity, not a renewable credential), so cert renewal has to
	// call this same endpoint with the same public_key every time — see
	// the M3 implementation report that first surfaced this: a naive
	// insert-only version 409s on every renewal. Look the device up by
	// public_key first and branch:
	//   - not found                     → register (insert), issue first cert, 201
	//   - found, same identity, active  → reissue a fresh cert for it, 200
	//   - found, same identity, revoked → 403 — renewal must NEVER be able to
	//     resurrect a revoked device. Silently reissuing here would let a
	//     device that still holds a valid Supabase refresh token (M3 retains
	//     one for exactly this renewal flow) undo a user's revocation just by
	//     continuing to run its own renewal loop, defeating design doc §6
	//     step 5's revocation guarantee.
	//   - found, different identity     → 409 — a genuine collision/replay,
	//     not a renewal.
	let deviceRow: typeof device.$inferSelect
	let status: 200 | 201 = 201

	const [existing] = await db
		.select()
		.from(device)
		.where(eq(device.publicKey, body.public_key))
		.limit(1)

	if (existing) {
		if (existing.identityId !== identityId) {
			return c.json(
				{ error: 'conflict', message: 'This device public key is already registered' },
				409,
			)
		}
		if (existing.revokedAt !== null) {
			return c.json(
				{
					error: 'forbidden',
					message: 'This device has been revoked. Register a new device instead.',
				},
				403,
			)
		}
		deviceRow = existing
		status = 200
	} else {
		try {
			const [inserted] = await db
				.insert(device)
				.values({
					identityId,
					publicKey: body.public_key,
					platform: body.platform,
					displayName: body.display_name,
				})
				.returning()
			if (!inserted) {
				return c.json({ error: 'internal_error', message: 'Failed to register device' }, 500)
			}
			deviceRow = inserted
		} catch (err) {
			// Unique violation on device.public_key — a concurrent request won
			// the race between our select above and this insert.
			const code = (err as { code?: string }).code
			if (code === '23505') {
				return c.json(
					{ error: 'conflict', message: 'This device public key is already registered' },
					409,
				)
			}
			throw err
		}
	}

	const expiresAt = new Date(Date.now() + DEVICE_CERT_TTL_MS)
	const cert = issueCert(
		{
			deviceId: deviceRow.id,
			identityId,
			publicKey: deviceRow.publicKey,
			expiresAt,
		},
		env.VAERKSTED_AUTH_SIGNING_PRIVATE_KEY,
	)

	const [certRow] = await db
		.insert(deviceCert)
		.values({
			deviceId: deviceRow.id,
			identityId,
			expiresAt,
			signature: cert.signature,
		})
		.returning()
	if (!certRow) {
		return c.json({ error: 'internal_error', message: 'Failed to issue device cert' }, 500)
	}

	return c.json(
		{
			device_id: deviceRow.id,
			identity_id: identityId,
			public_key: deviceRow.publicKey,
			expires_at: cert.expires_at,
			signature: cert.signature,
		},
		status,
	)
})

const deviceIdParamSchema = z.string().uuid()

// POST /devices/:id/revoke — session or device-cert authenticated (design
// doc §6 step 5: "POST /devices/:id/revoke lets a user kill a lost device
// from any other linked device"). Either auth path resolves to an
// `identityId`; the target device must belong to that same identity.
devicesRoute.post('/devices/:id/revoke', sessionOrDeviceCertMiddleware(), async (c) => {
	const db = c.get('db')
	const identityId = c.get('identityId')
	if (!identityId) {
		return c.json({ error: 'unauthorized' }, 401)
	}

	const idParam = deviceIdParamSchema.safeParse(c.req.param('id'))
	if (!idParam.success) {
		return c.json({ error: 'invalid_request', message: 'Invalid device id' }, 400)
	}

	const [targetDevice] = await db.select().from(device).where(eq(device.id, idParam.data)).limit(1)
	if (!targetDevice) {
		return c.json({ error: 'not_found' }, 404)
	}
	if (targetDevice.identityId !== identityId) {
		// Deliberately 404, not 403 — don't reveal that a device id exists
		// under a different identity.
		return c.json({ error: 'not_found' }, 404)
	}

	const [revoked] = await db
		.update(device)
		.set({ revokedAt: new Date() })
		.where(eq(device.id, idParam.data))
		.returning()

	return c.json({
		device_id: revoked?.id,
		revoked_at: revoked?.revokedAt,
	})
})
