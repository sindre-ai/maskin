import { actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { directPostChannelsFromConfig } from '../../lib/integrations/providers/slack/send-object'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: routes } = await import('../../routes/integrations-slack-direct-channels')

function buildApp() {
	return createIntegrationApp({
		path: '/api/integrations/slack/direct-post-channels',
		module: routes as never,
	})
}

function put(workspaceId: string, body: unknown) {
	return new Request('http://localhost/api/integrations/slack/direct-post-channels', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

async function insertSlack(
	workspaceId: string,
	actorId: string,
	config: Record<string, unknown> = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'slack',
			status: 'active',
			credentials: 'x',
			config: { system_actor_id: 'keep-me', ...config },
			createdBy: actorId,
		})
		.returning()
	return row
}

async function readConfig(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return row?.config as Record<string, unknown>
}

describe('PUT /api/integrations/slack/direct-post-channels', () => {
	it('saves the list, keeps the rest of the config, and drops duplicates', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const slack = await insertSlack(ws.id, actorId)

		const res = await buildApp().request(
			put(ws.id, { channels: ['C0AAAAAAAAA', 'C0AAAAAAAAA', 'C0BBBBBBBBB'] }),
		)
		expect(res.status).toBe(200)

		const config = await readConfig(slack.id)
		expect(directPostChannelsFromConfig(config)).toEqual(['C0AAAAAAAAA', 'C0BBBBBBBBB'])
		expect(config.system_actor_id).toBe('keep-me')
	})

	it('replaces an earlier list, and an empty list is kept as empty', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const slack = await insertSlack(ws.id, actorId, { slack_direct_post_channels: ['C0AAAAAAAAA'] })

		const res = await buildApp().request(put(ws.id, { channels: [] }))
		expect(res.status).toBe(200)
		expect(directPostChannelsFromConfig(await readConfig(slack.id))).toEqual([])
	})

	it('rejects names, DM ids and malformed bodies with 400 and changes nothing', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const slack = await insertSlack(ws.id, actorId)
		const app = buildApp()

		for (const channels of [['#general'], ['D0AAAAAAAAA'], ['c0aaaaaaaaa'], 'C0AAAAAAAAA']) {
			const res = await app.request(put(ws.id, { channels }))
			expect(res.status).toBe(400)
		}
		expect(directPostChannelsFromConfig(await readConfig(slack.id))).toBeUndefined()
	})

	it('404s when Slack is not connected in the workspace', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const res = await buildApp().request(put(ws.id, { channels: ['C0AAAAAAAAA'] }))
		expect(res.status).toBe(404)
	})

	it('refuses a workspace member who is not an admin or owner', async () => {
		const owner = await insertActor(db)
		const ws = await insertWorkspace(db, owner.id)
		const slack = await insertSlack(ws.id, owner.id)
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: getTestActorId(),
			role: 'member',
		})

		const res = await buildApp().request(put(ws.id, { channels: ['C0AAAAAAAAA'] }))
		expect(res.status).toBe(403)
		expect(directPostChannelsFromConfig(await readConfig(slack.id))).toBeUndefined()
	})

	it('refuses a viewer', async () => {
		const owner = await insertActor(db)
		const ws = await insertWorkspace(db, owner.id)
		await insertSlack(ws.id, owner.id)
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: getTestActorId(),
			role: 'viewer',
		})

		const res = await buildApp().request(put(ws.id, { channels: ['C0AAAAAAAAA'] }))
		expect(res.status).toBe(403)
	})

	it('refuses an agent, even one that owns the workspace, so it cannot allow its own channel', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const slack = await insertSlack(ws.id, actorId)
		await db.update(actors).set({ type: 'agent' }).where(eq(actors.id, actorId))
		try {
			const res = await buildApp().request(put(ws.id, { channels: ['C0AAAAAAAAA'] }))
			expect(res.status).toBe(403)
			expect(directPostChannelsFromConfig(await readConfig(slack.id))).toBeUndefined()
		} finally {
			await db.update(actors).set({ type: 'human' }).where(eq(actors.id, actorId))
		}
	})

	it('refuses a caller who is not in the workspace at all', async () => {
		const owner = await insertActor(db)
		const ws = await insertWorkspace(db, owner.id)
		await insertSlack(ws.id, owner.id)
		const res = await buildApp().request(put(ws.id, { channels: ['C0AAAAAAAAA'] }))
		expect(res.status).toBe(403)
	})
})
