import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import {
	getStarredObjectIds,
	isObjectStarredByActor,
	starObject,
	unstarObject,
} from '../../services/star-state'
import { createTestContext } from '../setup'

// Unit-scoped: assert the star-state service's call shape against the mock DB.
// Round-trip semantics (composite-PK idempotency, cross-actor isolation, real
// events row + NOTIFY) are exercised end-to-end in
// __tests__/integration/star-state.test.ts against real Postgres.

describe('star-state service', () => {
	describe('starObject', () => {
		it('inserts one star_state row and one events row tagged mutation_type=star', async () => {
			const { db, mockResults, calls } = createTestContext()
			const starredAt = new Date('2026-09-08T10:00:00Z')
			// First insert (.values.onConflictDoUpdate.returning) → star_state row;
			// second insert (.values) → events row (no .returning, so [] is fine).
			mockResults.insertQueue = [[{ starredAt }], []]

			const workspaceId = randomUUID()
			const actorId = randomUUID()
			const objectId = randomUUID()
			const result = await starObject(db as Database, {
				workspaceId,
				actorId,
				objectId,
				objectType: 'task',
			})

			expect(result).toEqual({ isStarredByMe: true, starredAt })

			expect(calls.inserts).toHaveLength(2)
			expect(calls.inserts[0]).toMatchObject({
				workspaceId,
				actorId,
				entityType: 'object',
				entityId: objectId,
			})
			const eventInsert = calls.inserts[1] as {
				workspaceId: string
				actorId: string
				action: string
				entityType: string
				entityId: string
				data: { mutation_type: string; is_starred: boolean }
			}
			expect(eventInsert.workspaceId).toBe(workspaceId)
			expect(eventInsert.actorId).toBe(actorId)
			expect(eventInsert.action).toBe('starred')
			expect(eventInsert.entityType).toBe('task')
			expect(eventInsert.entityId).toBe(objectId)
			// Load-bearing tag for the D5 PostHog cross-device check — do not drop.
			expect(eventInsert.data.mutation_type).toBe('star')
			expect(eventInsert.data.is_starred).toBe(true)
		})

		it('falls back to a fresh Date when the returning-row is empty (shouldnt happen in prod)', async () => {
			const { db } = createTestContext()
			// No insertQueue → returning() resolves to []. Guards against a NaN or
			// undefined leaking to the caller if the DB ever returns nothing.
			const result = await starObject(db as Database, {
				workspaceId: randomUUID(),
				actorId: randomUUID(),
				objectId: randomUUID(),
				objectType: 'task',
			})
			expect(result.isStarredByMe).toBe(true)
			expect(result.starredAt).toBeInstanceOf(Date)
		})
	})

	describe('unstarObject', () => {
		it('deletes the star_state row and appends events row tagged mutation_type=star, is_starred=false', async () => {
			const { db, calls } = createTestContext()
			const workspaceId = randomUUID()
			const actorId = randomUUID()
			const objectId = randomUUID()

			const result = await unstarObject(db as Database, {
				workspaceId,
				actorId,
				objectId,
				objectType: 'bet',
			})

			expect(result).toEqual({ isStarredByMe: false })
			// Exactly one events insert; the delete path has no insert.
			expect(calls.inserts).toHaveLength(1)
			const eventInsert = calls.inserts[0] as {
				action: string
				entityType: string
				data: { mutation_type: string; is_starred: boolean }
			}
			expect(eventInsert.action).toBe('unstarred')
			expect(eventInsert.entityType).toBe('bet')
			expect(eventInsert.data.mutation_type).toBe('star')
			expect(eventInsert.data.is_starred).toBe(false)
		})
	})

	describe('isObjectStarredByActor', () => {
		it('returns true when a row exists', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = [{ entityId: randomUUID() }]
			await expect(
				isObjectStarredByActor(db as Database, {
					actorId: randomUUID(),
					objectId: randomUUID(),
				}),
			).resolves.toBe(true)
		})

		it('returns false when no row exists', async () => {
			const { db } = createTestContext()
			await expect(
				isObjectStarredByActor(db as Database, {
					actorId: randomUUID(),
					objectId: randomUUID(),
				}),
			).resolves.toBe(false)
		})
	})

	describe('getStarredObjectIds', () => {
		it('short-circuits on an empty id list without hitting the DB', async () => {
			const { db } = createTestContext()
			await expect(
				getStarredObjectIds(db as Database, { actorId: randomUUID(), objectIds: [] }),
			).resolves.toEqual(new Set())
		})

		it('returns the intersection as a Set<string>', async () => {
			const { db, mockResults } = createTestContext()
			const a = randomUUID()
			const b = randomUUID()
			const c = randomUUID()
			mockResults.select = [{ entityId: a }, { entityId: c }]

			const starred = await getStarredObjectIds(db as Database, {
				actorId: randomUUID(),
				objectIds: [a, b, c],
			})
			expect(starred.has(a)).toBe(true)
			expect(starred.has(b)).toBe(false)
			expect(starred.has(c)).toBe(true)
		})
	})
})
