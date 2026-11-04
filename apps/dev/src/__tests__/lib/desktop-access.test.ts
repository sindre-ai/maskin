import { describe, expect, it } from 'vitest'
import { canAccessDesktop, resolveDesktopAgent } from '../../lib/desktop-access'

const WS = '11111111-1111-4111-8111-111111111111'
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'
const HUMAN = '66666666-6666-4666-8666-666666666666'

// select().from()[.innerJoin()].where().limit(): each call to select() takes the next queued result.
function fakeDb(...results: unknown[][]) {
	const queue = [...results]
	let selects = 0
	const db = {
		select: () => {
			selects++
			const rows = queue.shift() ?? []
			const q = { from: () => q, innerJoin: () => q, where: () => q, limit: async () => rows }
			return q
		},
	}
	return { db: db as never, selects: () => selects }
}

describe('resolveDesktopAgent', () => {
	describe('an agent caller', () => {
		const agent = { actorId: AGENT, actorType: 'agent', workspaceId: WS }

		it('gets its own desktop without naming it, and no lookup is needed', async () => {
			const { db, selects } = fakeDb()
			expect(await resolveDesktopAgent(db, { ...agent, requestedAgentId: undefined })).toEqual({
				ok: true,
				agentId: AGENT,
			})
			expect(selects()).toBe(0)
		})

		it('may name itself, in any letter case', async () => {
			const { db } = fakeDb()
			expect(
				await resolveDesktopAgent(db, { ...agent, requestedAgentId: AGENT.toUpperCase() }),
			).toEqual({ ok: true, agentId: AGENT })
		})

		it('is refused with 403 when it names another agent, even one that really exists', async () => {
			const { db, selects } = fakeDb([{ id: OTHER }]) // the colleague exists in the workspace
			expect(await resolveDesktopAgent(db, { ...agent, requestedAgentId: OTHER })).toEqual({
				ok: false,
				status: 403,
				message: 'An agent can only use its own computer',
			})
			// Refused before any lookup: it must not learn whether the colleague exists.
			expect(selects()).toBe(0)
		})
	})

	describe('a human caller', () => {
		const human = { actorId: HUMAN, actorType: 'human', workspaceId: WS }

		it('must say whose computer it is', async () => {
			const { db } = fakeDb()
			expect(
				await resolveDesktopAgent(db, { ...human, requestedAgentId: undefined }),
			).toMatchObject({
				ok: false,
				status: 400,
			})
		})

		it('may open any agent that is in the workspace', async () => {
			const { db } = fakeDb([{ id: OTHER }])
			expect(await resolveDesktopAgent(db, { ...human, requestedAgentId: OTHER })).toEqual({
				ok: true,
				agentId: OTHER,
			})
		})

		it('gets 404 for an agent that is not in the workspace (or is not an agent)', async () => {
			const { db } = fakeDb([])
			expect(await resolveDesktopAgent(db, { ...human, requestedAgentId: OTHER })).toMatchObject({
				ok: false,
				status: 404,
			})
		})
	})

	it('treats any non-agent actor like a human, not like an agent', async () => {
		const { db } = fakeDb()
		expect(
			await resolveDesktopAgent(db, {
				actorId: HUMAN,
				actorType: undefined,
				workspaceId: WS,
				requestedAgentId: undefined,
			}),
		).toMatchObject({ ok: false, status: 400 })
	})

	it.each(['', 'nope', '../x', `${AGENT};x`])(
		'rejects a malformed agent_id %j with 400',
		async (bad) => {
			const { db } = fakeDb()
			expect(
				await resolveDesktopAgent(db, {
					actorId: HUMAN,
					actorType: 'human',
					workspaceId: WS,
					requestedAgentId: bad,
				}),
			).toMatchObject({ ok: false, status: 400 })
		},
	)
})

describe('canAccessDesktop (the stream relay check)', () => {
	it('lets an agent stream its own desktop', async () => {
		const { db } = fakeDb([{ type: 'agent' }])
		expect(await canAccessDesktop(db, AGENT, WS, AGENT)).toBe(true)
	})

	it('refuses an agent streaming another agent desktop', async () => {
		const { db } = fakeDb([{ type: 'agent' }])
		expect(await canAccessDesktop(db, AGENT, WS, OTHER)).toBe(false)
	})

	it('lets a human stream an agent that is still in the workspace', async () => {
		const { db } = fakeDb([{ type: 'human' }], [{ id: OTHER }])
		expect(await canAccessDesktop(db, HUMAN, WS, OTHER)).toBe(true)
	})

	it('refuses a human once the agent has left the workspace', async () => {
		const { db } = fakeDb([{ type: 'human' }], [])
		expect(await canAccessDesktop(db, HUMAN, WS, OTHER)).toBe(false)
	})

	it('refuses an actor that no longer exists', async () => {
		const { db } = fakeDb([])
		expect(await canAccessDesktop(db, HUMAN, WS, OTHER)).toBe(false)
	})
})
