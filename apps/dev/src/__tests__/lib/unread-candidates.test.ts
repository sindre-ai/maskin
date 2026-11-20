import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	MAX_UNREAD_CANDIDATE_ENTITIES,
	_resetUnreadCandidateCache,
	unreadCandidateEntityIds,
} from '../../lib/unread-candidates'
import { createTestContext } from '../setup'

const workspaceId = randomUUID()
const actorId = randomUUID()

// With nothing cached the selects come off the queue in this order: newest event id, onboarding
// threads, scan of every mention, newest event id again, scan of mentions since the first one.
// With a cached scan only the last three remain: onboarding threads, newest event id, new mentions.
function coldQueue(opts: {
	seenUpTo: number
	all: string[]
	now: number
	fresh: string[]
	onboarding?: string[]
}) {
	return [
		[{ id: opts.seenUpTo }],
		(opts.onboarding ?? []).map((id) => ({ id })),
		opts.all.map((entityId) => ({ entityId })),
		[{ id: opts.now }],
		opts.fresh.map((entityId) => ({ entityId })),
	]
}

function warmQueue(opts: { now: number; fresh: string[]; onboarding?: string[] }) {
	return [
		(opts.onboarding ?? []).map((id) => ({ id })),
		[{ id: opts.now }],
		opts.fresh.map((entityId) => ({ entityId })),
	]
}

describe('unreadCandidateEntityIds', () => {
	beforeEach(() => {
		_resetUnreadCandidateCache()
	})

	it('lists every entity with a mentioning comment on the first read', async () => {
		const a = randomUUID()
		const b = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: [a, b], now: 500, fresh: [] })

		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids?.sort()).toEqual([a, b].sort())
	})

	it('adds a mention written since the last read without scanning the old ones again', async () => {
		const a = randomUUID()
		const b = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: [a], now: 500, fresh: [] })
		await unreadCandidateEntityIds(db, workspaceId, actorId)

		// Only three selects are queued: the second read must not run the full scan.
		mockResults.selectQueue = warmQueue({ now: 520, fresh: [b] })
		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids?.sort()).toEqual([a, b].sort())
	})

	it('keeps an entity found earlier even when the newer scan no longer returns it', async () => {
		const a = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: [a], now: 500, fresh: [] })
		await unreadCandidateEntityIds(db, workspaceId, actorId)

		mockResults.selectQueue = warmQueue({ now: 520, fresh: [] })
		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids).toEqual([a])
	})

	it('keeps one person from seeing the list of another', async () => {
		const mine = randomUUID()
		const theirs = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: [mine], now: 500, fresh: [] })
		await unreadCandidateEntityIds(db, workspaceId, actorId)

		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: [theirs], now: 500, fresh: [] })
		const ids = await unreadCandidateEntityIds(db, workspaceId, randomUUID())

		expect(ids).toEqual([theirs])
	})

	it('adds the onboarding threads whether or not they mention the person', async () => {
		const mentioned = randomUUID()
		const onboarding = randomUUID()
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({
			seenUpTo: 500,
			all: [mentioned],
			now: 500,
			fresh: [],
			onboarding: [onboarding],
		})

		const ids = await unreadCandidateEntityIds(db, workspaceId, actorId)

		expect(ids?.sort()).toEqual([mentioned, onboarding].sort())
	})

	it('returns null when the list is too long to be worth passing on', async () => {
		const many = Array.from({ length: MAX_UNREAD_CANDIDATE_ENTITIES + 1 }, () => randomUUID())
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = coldQueue({ seenUpTo: 500, all: many, now: 500, fresh: [] })

		expect(await unreadCandidateEntityIds(db, workspaceId, actorId)).toBeNull()
	})
})
