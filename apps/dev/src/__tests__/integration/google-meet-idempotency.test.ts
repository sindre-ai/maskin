import { googleMeetSpaceIdempotency } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	readIdempotency,
	recordIdempotency,
} from '../../lib/integrations/providers/google-meet/idempotency'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

// The `google_meet__create_space` acceptance criterion — "same key returns the
// same space_name on second call, Maskin-side idempotency table upheld" — is
// enforced by the composite unique index on (workspace_id, idempotency_key)
// in migration 0070. Unit tests mock `recordIdempotency`; only a real Postgres
// can prove the constraint actually fires and the ON CONFLICT branch reads
// back the winner's row.

describe('google_meet_space_idempotency (migration 0070)', () => {
	it('first insert wins, second insert with the same (workspace_id, key) reads back the winner', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)

		const first = await recordIdempotency(db, {
			workspaceId: ws.id,
			idempotencyKey: 'k-1',
			spaceName: 'spaces/winner',
			meetingCode: 'win-code',
			meetingUri: 'https://meet.google.com/winner',
		})
		expect(first.inserted).toBe(true)
		expect(first.row.spaceName).toBe('spaces/winner')

		// Second call with the same (workspace, key) but different space payload
		// — this is what a losing racer would attempt after independently
		// provisioning its own Meet space. The unique index blocks the insert;
		// the caller reads back the winner's row.
		const second = await recordIdempotency(db, {
			workspaceId: ws.id,
			idempotencyKey: 'k-1',
			spaceName: 'spaces/loser',
			meetingCode: 'lose-code',
			meetingUri: 'https://meet.google.com/loser',
		})
		expect(second.inserted).toBe(false)
		expect(second.row.spaceName).toBe('spaces/winner')
		expect(second.row.meetingCode).toBe('win-code')
		expect(second.row.meetingUri).toBe('https://meet.google.com/winner')

		const rows = await db
			.select({ id: googleMeetSpaceIdempotency.id })
			.from(googleMeetSpaceIdempotency)
			.where(
				and(
					eq(googleMeetSpaceIdempotency.workspaceId, ws.id),
					eq(googleMeetSpaceIdempotency.idempotencyKey, 'k-1'),
				),
			)
		expect(rows).toHaveLength(1)
	})

	it('same idempotency_key across two workspaces stores independent rows (workspace scoping)', async () => {
		const actor = await insertActor(db)
		const wsA = await insertWorkspace(db, actor.id)
		const wsB = await insertWorkspace(db, actor.id)

		const a = await recordIdempotency(db, {
			workspaceId: wsA.id,
			idempotencyKey: 'shared-key',
			spaceName: 'spaces/A',
			meetingCode: 'a-code',
			meetingUri: 'https://meet.google.com/A',
		})
		const b = await recordIdempotency(db, {
			workspaceId: wsB.id,
			idempotencyKey: 'shared-key',
			spaceName: 'spaces/B',
			meetingCode: 'b-code',
			meetingUri: 'https://meet.google.com/B',
		})
		expect(a.inserted).toBe(true)
		expect(b.inserted).toBe(true)

		const back = await readIdempotency(db, { workspaceId: wsA.id, idempotencyKey: 'shared-key' })
		expect(back?.spaceName).toBe('spaces/A')
	})

	it('readIdempotency returns null when no row exists for (workspace, key)', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)

		const back = await readIdempotency(db, {
			workspaceId: ws.id,
			idempotencyKey: 'never-written',
		})
		expect(back).toBeNull()
	})
})
