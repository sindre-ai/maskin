import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	MAX_UNREAD_CANDIDATE_ENTITIES,
	unreadCandidateEntityIds,
} from '../../lib/unread-candidates'
import { createTestContext } from '../setup'

const workspaceId = randomUUID()
const actorId = randomUUID()

// The two selects run together: the entities the person was mentioned on, then the workspace's
// onboarding threads.
function queue(mentioned: string[], onboarding: string[] = []) {
	return [mentioned.map((entityId) => ({ entityId })), onboarding.map((id) => ({ id }))]
}

describe('unreadCandidateEntityIds', () => {
	it('lists every entity the person was mentioned on', async () => {
		const a = randomUUID()
		const b = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = queue([a, b])

		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids?.sort()).toEqual([a, b].sort())
	})

	it('adds the onboarding threads whether or not they mention the person', async () => {
		const mentioned = randomUUID()
		const onboarding = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = queue([mentioned], [onboarding])

		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids?.sort()).toEqual([mentioned, onboarding].sort())
	})

	it('lists an entity once when it is both mentioned and an onboarding thread', async () => {
		const both = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = queue([both], [both])

		expect(await unreadCandidateEntityIds(db, workspaceId, actorId)).toEqual([both])
	})

	it('returns an empty list when nothing mentions the person', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = queue([])

		expect(await unreadCandidateEntityIds(db, workspaceId, actorId)).toEqual([])
	})

	it('returns null when the list is too long to be worth passing on', async () => {
		const many = Array.from({ length: MAX_UNREAD_CANDIDATE_ENTITIES + 1 }, () => randomUUID())
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = queue(many)

		expect(await unreadCandidateEntityIds(db, workspaceId, actorId)).toBeNull()
	})
})
