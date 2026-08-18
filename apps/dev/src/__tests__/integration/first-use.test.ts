import {
	events,
	marketplaceLoops,
	objects,
	subscriptions,
	workspaceMembers,
} from '@maskin/db/schema'
import { FIRST_USE_SESSION_TITLE, FIRST_USE_SUGGESTIONS_TITLE } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

const {
	FIRST_USE_SESSION_TYPE,
	pickFirstUseSuggestions,
	resolveFirstUseAgents,
	runFirstUse,
	seedFirstUse,
} = await import('../../services/first-use')

// The three agents first use writes as. Names match what
// `seedDefaultAgentActors` creates, since that is what `resolveFirstUseAgents`
// looks them up by.
async function seedAgents(workspaceId: string, createdBy: string) {
	const ids: Record<string, string> = {}
	const roles = [
		['chiefOfStaff', 'Chief of Staff'],
		['researchAgent', 'Research Agent'],
		['strategist', 'Strategist'],
	] as const
	for (const [key, name] of roles) {
		const agent = await insertActor(db, { type: 'agent', name })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
		ids[key] = agent.id
	}
	return {
		chiefOfStaff: ids.chiefOfStaff as string,
		researchAgent: ids.researchAgent as string,
		strategist: ids.strategist as string,
	}
}

async function cardsFor(workspaceId: string) {
	return db
		.select({
			id: objects.id,
			title: objects.title,
			status: objects.status,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, FIRST_USE_SESSION_TYPE)))
}

async function commentsOn(objectId: string) {
	return db
		.select({ actorId: events.actorId, data: events.data })
		.from(events)
		.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
		.orderBy(events.id)
}

describe('First use seeding (integration)', () => {
	let ownerId: string
	let workspaceId: string
	let agents: { chiefOfStaff: string; researchAgent: string; strategist: string }

	beforeEach(async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Charlie Brown' })
		ownerId = owner.id
		const ws = await insertWorkspace(db, ownerId, { name: 'Acme' })
		workspaceId = ws.id
		agents = await seedAgents(workspaceId, ownerId)
	})

	function args(overrides: Record<string, unknown> = {}) {
		return {
			workspaceId,
			workspaceName: 'Acme',
			ownerActorId: ownerId,
			ownerName: 'Charlie Brown',
			agents,
			agentsWorking: false,
			...overrides,
		}
	}

	it('writes both seeded cards, authored by the Chief of Staff', async () => {
		const seeded = await seedFirstUse(db, args())
		expect(seeded).not.toBeNull()

		const cards = await cardsFor(workspaceId)
		expect(cards.map((c) => c.title).sort()).toEqual(
			[FIRST_USE_SESSION_TITLE, FIRST_USE_SUGGESTIONS_TITLE].sort(),
		)

		const intro = cards.find((c) => c.title === FIRST_USE_SESSION_TITLE)
		const comments = await commentsOn(intro?.id as string)
		expect(comments.length).toBeGreaterThan(0)
		for (const comment of comments) {
			expect(comment.actorId).toBe(agents.chiefOfStaff)
		}
	})

	it('subscribes the owner to both cards so they land in For You', async () => {
		const seeded = await seedFirstUse(db, args())
		const rows = await db
			.select({ entityId: subscriptions.entityId })
			.from(subscriptions)
			.where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.actorId, ownerId)))
		expect(rows.map((r) => r.entityId).sort()).toEqual(
			[seeded?.sessionObjectId, seeded?.suggestionsObjectId].sort(),
		)
	})

	it('leaves the cards unread — no read_state row is written for the owner', async () => {
		const seeded = await seedFirstUse(db, args())
		const { getUnreadCount } = await import('../../services/subscriptions')
		const unread = await getUnreadCount(db, {
			workspaceId,
			actorId: ownerId,
			entityType: 'object',
			entityId: seeded?.sessionObjectId as string,
		})
		expect(unread).toBeGreaterThan(0)
	})

	it('is idempotent — a second run adds no cards and no comments', async () => {
		const first = await seedFirstUse(db, args())
		const commentsAfterFirst = await commentsOn(first?.sessionObjectId as string)

		const second = await seedFirstUse(db, args())
		expect(second?.sessionObjectId).toBe(first?.sessionObjectId)
		expect(second?.suggestionsObjectId).toBe(first?.suggestionsObjectId)

		expect(await cardsFor(workspaceId)).toHaveLength(2)
		expect(await commentsOn(first?.sessionObjectId as string)).toHaveLength(
			commentsAfterFirst.length,
		)
	})

	it('offers real marketplace loops, capped and linked by id', async () => {
		// The catalog is workspace-independent, so this test owns it outright
		// rather than asserting against whatever another test happened to leave.
		await db.delete(marketplaceLoops)
		const inserted = await db
			.insert(marketplaceLoops)
			.values(
				['Alpha Loop', 'Beta Loop', 'Delta Loop', 'Echo Loop', 'Foxtrot Loop'].map((name, i) => ({
					name,
					slug: `loop-${i}`,
					description: `${name} does something useful.`,
					version: '1.0.0',
				})),
			)
			.returning({ id: marketplaceLoops.id, name: marketplaceLoops.name })

		const picked = await pickFirstUseSuggestions(db)
		// Capped at four, ordered by name, so the card is a shortlist not a listing.
		expect(picked.map((p) => p.name)).toEqual([
			'Alpha Loop',
			'Beta Loop',
			'Delta Loop',
			'Echo Loop',
		])

		const seeded = await seedFirstUse(db, args())
		const comments = await commentsOn(seeded?.suggestionsObjectId as string)
		const refs = comments.flatMap(
			(c) => ((c.data as Record<string, unknown>)?.refs as Array<Record<string, string>>) ?? [],
		)
		const alpha = inserted.find((row) => row.name === 'Alpha Loop')
		expect(refs.map((r) => r.path)).toContain(`marketplace/${alpha?.id}`)
		expect(refs.every((r) => r.tag === 'LOOP')).toBe(true)
	})

	it('still seeds a usable card when the marketplace catalog is empty', async () => {
		await db.delete(marketplaceLoops)
		const seeded = await seedFirstUse(db, args())
		const comments = await commentsOn(seeded?.suggestionsObjectId as string)
		expect(comments).toHaveLength(1)
		const content = (comments[0]?.data as Record<string, unknown>)?.content as string
		expect(content).not.toContain('already wired')
	})

	it('carries the quick replies through as comment metadata chips', async () => {
		const seeded = await seedFirstUse(db, args())
		const comments = await commentsOn(seeded?.sessionObjectId as string)
		const chips = comments
			.map((c) => (c.data as Record<string, unknown>)?.metadata as Record<string, unknown>)
			.find((m) => m?.chips)
		expect(chips?.chips).toEqual(['What do you do?', 'Can I skip this?'])
	})

	it('marks the context card as the one carrying a decision', async () => {
		const seeded = await seedFirstUse(db, args())
		const cards = await cardsFor(workspaceId)
		const markers = cards.map((c) => (c.metadata as Record<string, unknown>)?.first_use_card)
		// The seeded pair are threads; `context` is written by the Research Agent.
		expect(markers.sort()).toEqual(['intro', 'suggestions'])
	})
})

describe('resolveFirstUseAgents (integration)', () => {
	it('returns null when any of the three agents is missing', async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Solo' })
		const ws = await insertWorkspace(db, owner.id, { name: 'Bare' })
		const partial = await insertActor(db, { type: 'agent', name: 'Chief of Staff' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: partial.id, role: 'member' })

		expect(await resolveFirstUseAgents(db, ws.id)).toBeNull()
	})

	it('resolves all three once they are members of the workspace', async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Full' })
		const ws = await insertWorkspace(db, owner.id, { name: 'Staffed' })
		const seeded = await seedAgents(ws.id, owner.id)

		expect(await resolveFirstUseAgents(db, ws.id)).toEqual(seeded)
	})
})

describe('runFirstUse (integration)', () => {
	it('starts the research session only once the cards are written', async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Ada Lovelace' })
		const ws = await insertWorkspace(db, owner.id, { name: 'Analytical' })
		const agents = await seedAgents(ws.id, owner.id)

		const started: Array<{ actorId: string; actionPrompt: string }> = []
		const seeded = await runFirstUse(
			db,
			{
				createSession: async (_workspaceId, params) => {
					// The cards must already exist by the time the agent is told to work.
					const cards = await cardsFor(ws.id)
					expect(cards).toHaveLength(2)
					started.push(params)
					return {}
				},
			},
			{
				workspaceId: ws.id,
				workspaceName: 'Analytical',
				ownerActorId: owner.id,
				ownerName: 'Ada Lovelace',
				agents,
				agentsWorking: true,
			},
		)

		expect(seeded).not.toBeNull()
		expect(started).toHaveLength(1)
		expect(started[0]?.actorId).toBe(agents.researchAgent)
		expect(started[0]?.actionPrompt).toContain('workspace-first-use')
		expect(started[0]?.actionPrompt).toContain(agents.strategist)
		expect(started[0]?.actionPrompt).toContain(owner.id)
	})

	it('still leaves the seeded cards behind when the session cannot start', async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Grace Hopper' })
		const ws = await insertWorkspace(db, owner.id, { name: 'Compiler' })
		const agents = await seedAgents(ws.id, owner.id)

		const seeded = await runFirstUse(
			db,
			{
				createSession: async () => {
					throw new Error('no agent server available')
				},
			},
			{
				workspaceId: ws.id,
				workspaceName: 'Compiler',
				ownerActorId: owner.id,
				ownerName: 'Grace Hopper',
				agents,
				agentsWorking: true,
			},
		)

		expect(seeded).not.toBeNull()
		expect(await cardsFor(ws.id)).toHaveLength(2)
	})

	it('does not start a session when no agent work will follow', async () => {
		const owner = await insertActor(db, { type: 'human', name: 'Alan Turing' })
		const ws = await insertWorkspace(db, owner.id, { name: 'Bombe' })
		const agents = await seedAgents(ws.id, owner.id)

		let called = false
		await runFirstUse(
			db,
			{
				createSession: async () => {
					called = true
					return {}
				},
			},
			{
				workspaceId: ws.id,
				workspaceName: 'Bombe',
				ownerActorId: owner.id,
				ownerName: 'Alan Turing',
				agents,
				agentsWorking: false,
			},
		)

		expect(called).toBe(false)
	})
})
