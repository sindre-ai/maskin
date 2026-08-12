import { Hono } from 'hono'
import { z } from 'zod'
import { syncBlob } from '../db/schema'
import { deviceCertMiddleware } from '../lib/device-cert-middleware'
import { fanOut } from '../lib/ws-registry'
import type { AppEnv } from '../types'

// POST /sync/push — device-cert authenticated. Design doc §9: "accept
// POST /sync/push (blob + metadata: device id, meeting id, field, logical
// clock), fan out to online devices over a WebSocket."
//
// device_id/identity_id come from the verified cert in context (set by
// deviceCertMiddleware), never from the request body — a device cannot push
// on another device's or identity's behalf just by naming it in the body.
const pushBodySchema = z.object({
	meeting_id: z.string().min(1),
	field: z.string().min(1),
	// Client-assigned, per-device monotonic counter — the server stores it
	// as-is and never interprets it (see schema.ts's comment on
	// syncBlob.logicalClock). Bounded to a safe integer so it round-trips
	// through JSON without precision loss.
	logical_clock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	payload: z.string(),
})

export const pushRoute = new Hono<AppEnv>()

pushRoute.post('/sync/push', deviceCertMiddleware(), async (c) => {
	const body = await c.req.json().catch(() => null)
	const parsed = pushBodySchema.safeParse(body)
	if (!parsed.success) {
		return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
	}

	const deviceId = c.get('deviceId')
	const identityId = c.get('identityId')
	const db = c.get('db')

	const [row] = await db
		.insert(syncBlob)
		.values({
			deviceId,
			identityId,
			meetingId: parsed.data.meeting_id,
			field: parsed.data.field,
			logicalClock: parsed.data.logical_clock,
			payload: parsed.data.payload,
		})
		.returning()

	if (!row) {
		return c.json({ error: 'internal_error', message: 'Insert did not return a row' }, 500)
	}

	const wireRow = {
		id: row.id,
		device_id: row.deviceId,
		identity_id: row.identityId,
		meeting_id: row.meetingId,
		field: row.field,
		logical_clock: row.logicalClock,
		payload: row.payload,
		server_seq: row.serverSeq,
		created_at: row.createdAt.toISOString(),
	}

	// Fan-out is best-effort/fire-and-forget (design doc §9's exact wire
	// contract): a disconnected device simply catches up later via
	// GET /sync/pull?since=. Never awaited against anything that could fail
	// the push itself — fanOut() already swallows per-socket send errors.
	fanOut(identityId, deviceId, { type: 'sync_blob', blob: wireRow })

	return c.json(wireRow, 201)
})
