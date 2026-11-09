import { events, actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

const ws = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

async function addMember(workspaceId: string, name: string, type: 'agent' | 'human' = 'agent') {
	const actor = await insertActor(db, { type, name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
	return actor
}

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Starter prompts on agents', () => {
	it('sets, reads and replaces an agent’s starters, keeping its tags and other metadata', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Opener')
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true, tags: ['Sales'] } })
			.where(eq(actors.id, agent.id))

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ starter_prompts: ['What needs me today?', '  Summarise the open decisions  '] },
				ws(workspace.id),
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			starter_prompts: string[]
			tags: string[]
			voice_enabled: boolean
		}
		expect(body.starter_prompts).toEqual(['What needs me today?', 'Summarise the open decisions'])
		expect(body.tags).toEqual(['Sales'])
		expect(body.voice_enabled).toBe(true)

		// The same value is stored (one JSONB merge, the other keys survive)…
		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, agent.id))
		expect(row.metadata).toEqual({
			voice_enabled: true,
			tags: ['Sales'],
			starter_prompts: ['What needs me today?', 'Summarise the open decisions'],
		})

		// …and read back by both the detail and the list the new-chat sheet uses.
		const get = await app.request(jsonGet(`/api/actors/${agent.id}`, ws(workspace.id)))
		expect(((await get.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([
			'What needs me today?',
			'Summarise the open decisions',
		])
		const list = await app.request(jsonGet('/api/actors', ws(workspace.id)))
		const rows = (await list.json()) as Array<{ id: string; starter_prompts: string[] }>
		expect(rows.find((r) => r.id === agent.id)?.starter_prompts).toEqual([
			'What needs me today?',
			'Summarise the open decisions',
		])

		const replaced = await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ starter_prompts: ['Only one'] },
				ws(workspace.id),
			),
		)
		expect(((await replaced.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([
			'Only one',
		])
		const cleared = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { starter_prompts: [] }, ws(workspace.id)),
		)
		expect(((await cleared.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([])
	})

	it('writing tags alone leaves the starters in place', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Both')
		await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ starter_prompts: ['Keep me'] },
				ws(workspace.id),
			),
		)
		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tags: ['Ops'] }, ws(workspace.id)),
		)
		const body = (await res.json()) as { starter_prompts: string[]; tags: string[] }
		expect(body.tags).toEqual(['Ops'])
		expect(body.starter_prompts).toEqual(['Keep me'])
	})

	it('records an event for a starter change, and none for a plain rename', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Audited')

		await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { name: 'Renamed' }, ws(workspace.id)),
		)
		await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ starter_prompts: ['Check the pipeline'] },
				ws(workspace.id),
			),
		)
		const rows = await db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityId, agent.id), eq(events.action, 'actor_starter_prompts_updated')))
		expect(rows).toHaveLength(1)
		expect((rows[0].data as { starter_prompts: string[] }).starter_prompts).toEqual([
			'Check the pipeline',
		])
	})

	it('refuses a fifth starter, a too long one, an empty one, a control character, a repeat and a person', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Strict')
		const person = await addMember(workspace.id, 'Hannah', 'human')
		const patch = (id: string, body: unknown, headers: Record<string, string> = ws(workspace.id)) =>
			app.request(jsonRequest('PATCH', `/api/actors/${id}`, body, headers))

		expect((await patch(agent.id, { starter_prompts: ['a', 'b', 'c', 'd', 'e'] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['x'.repeat(61)] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['   '] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['one\ntwo'] })).status).toBe(400)
		// C1 "next line" and the Unicode line separator hide a line break too.
		expect((await patch(agent.id, { starter_prompts: ['one\u0085two'] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['one two'] })).status).toBe(400)
		// A repeat is refused, not quietly dropped: capitals do not make it different, and the final
		// sigma is folded so "ΑΣ" and "ας" are one prompt, as on the Swift reader.
		expect((await patch(agent.id, { starter_prompts: ['Hi', 'hi'] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['ΑΣ', 'ας'] })).status).toBe(400)
		expect((await patch(agent.id, { starter_prompts: ['Hi', ' HI '] })).status).toBe(400)
		expect((await patch(person.id, { starter_prompts: ['Hi'] })).status).toBe(400)

		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, agent.id))
		expect(row.metadata ?? {}).not.toHaveProperty('starter_prompts')
	})

	it('writes without the workspace header, as the mailbox does, and records no event', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Headerless')

		// How the MCP update_actor tool calls: no X-Workspace-Id.
		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { starter_prompts: ['Keep going'] }, {}),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([
			'Keep going',
		])
		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, agent.id))
		expect(row.metadata).toEqual({ starter_prompts: ['Keep going'] })
		// The audit event is per workspace, so there is none without one.
		const rows = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.entityId, agent.id), eq(events.action, 'actor_starter_prompts_updated')))
		expect(rows).toHaveLength(0)
	})

	it('reset to defaults clears the starters and keeps tags and the other metadata', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const coach = await insertActor(db, { type: 'agent', name: 'Coach', isSystem: true })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: workspace.id, actorId: coach.id, role: 'member' })
		await db
			.update(actors)
			.set({
				metadata: {
					tags: ['Sales'],
					starter_prompts: ['What needs me today?'],
					avatar_version: 3,
					voice_enabled: true,
				},
			})
			.where(eq(actors.id, coach.id))

		const res = await app.request(
			jsonRequest('POST', `/api/actors/${coach.id}/reset`, undefined, ws(workspace.id)),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { starter_prompts: string[]; tags: string[] }
		expect(body.starter_prompts).toEqual([])
		expect(body.tags).toEqual(['Sales'])

		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, coach.id))
		expect(row.metadata).toEqual({ tags: ['Sales'], avatar_version: 3, voice_enabled: true })
	})

	it('reset on an actor with no metadata at all still works', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const coach = await insertActor(db, { type: 'agent', name: 'Bare Coach', isSystem: true })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: workspace.id, actorId: coach.id, role: 'member' })
		await db.update(actors).set({ metadata: null }).where(eq(actors.id, coach.id))

		const res = await app.request(
			jsonRequest('POST', `/api/actors/${coach.id}/reset`, undefined, ws(workspace.id)),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([])
	})

	it('accepts exactly four starters of exactly 60 characters', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Limit')
		const full = ['a', 'b', 'c', 'd'].map((c) => c.repeat(60))
		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { starter_prompts: full }, ws(workspace.id)),
		)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { starter_prompts: string[] }).starter_prompts).toEqual(full)
	})

	it('reads an agent with no starters, or a hand-edited non-list value, as an empty list', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const none = await addMember(workspace.id, 'Silent')
		const broken = await addMember(workspace.id, 'Broken')
		await db
			.update(actors)
			.set({ metadata: { starter_prompts: 'not a list' } })
			.where(eq(actors.id, broken.id))

		for (const id of [none.id, broken.id]) {
			const get = await app.request(jsonGet(`/api/actors/${id}`, ws(workspace.id)))
			expect(((await get.json()) as { starter_prompts: string[] }).starter_prompts).toEqual([])
		}
	})
})
