import { and, asc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { syncBlob } from '../db/schema'
import { deviceCertMiddleware } from '../lib/device-cert-middleware'
import type { AppEnv } from '../types'

// GET /sync/pull?since=<server_seq> — device-cert authenticated. Design doc
// §9: "GET /sync/pull?since=<clock> for reconnect/catch-up." Returns every
// sync_blob row for this identity_id (across ALL of that identity's
// devices, not just the caller's) with server_seq > since, ascending.
//
// "Everything after this server_seq" is inherently idempotent — repeating a
// pull with the same `since` is safe, and it needs no ack/delivered_at
// bookkeeping to handle offline-device catch-up (design doc §12 leaves
// retention/delivery-tracking policy an open question; this endpoint doesn't
// need to resolve it to be correct for M4).
//
// PAGE SIZE CAP — NOT an oversight, an open item for a later milestone: this
// endpoint caps at PAGE_SIZE rows and does not implement multi-page
// pagination beyond that (no `next_since`/cursor response field). A device
// that is offline long enough to have more than PAGE_SIZE undelivered blobs
// waiting will only receive the first page and must call pull again with an
// updated `since` — but this route does not currently signal "there is
// more" to the caller, so a naive client that pulls once and assumes it's
// caught up will silently miss data past the cap. Flagging this explicitly
// per the "no silent caps" principle: fixing it (e.g. a `has_more` flag,
// looping the client until an empty page) is real work for a follow-up
// milestone, not solved here.
const PAGE_SIZE = 500

export const pullRoute = new Hono<AppEnv>()

pullRoute.get('/sync/pull', deviceCertMiddleware(), async (c) => {
	const identityId = c.get('identityId')
	const db = c.get('db')

	// Safe numeric parsing per .claude/rules/input-validation.md — `since`
	// defaults to 0 if omitted or not a finite non-negative integer, rather
	// than letting NaN propagate into the query.
	const rawSince = c.req.query('since')
	const parsedSince = Number(rawSince)
	const since =
		rawSince !== undefined && Number.isFinite(parsedSince) && parsedSince >= 0 ? parsedSince : 0

	const rows = await db
		.select()
		.from(syncBlob)
		.where(and(eq(syncBlob.identityId, identityId), gt(syncBlob.serverSeq, since)))
		.orderBy(asc(syncBlob.serverSeq))
		.limit(PAGE_SIZE)

	const blobs = rows.map((row) => ({
		id: row.id,
		device_id: row.deviceId,
		identity_id: row.identityId,
		meeting_id: row.meetingId,
		field: row.field,
		logical_clock: row.logicalClock,
		payload: row.payload,
		server_seq: row.serverSeq,
		created_at: row.createdAt.toISOString(),
	}))

	return c.json({ blobs })
})
