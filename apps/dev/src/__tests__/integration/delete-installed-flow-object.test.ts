import { installedLoops, marketplaceLoops, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertObject, insertWorkspace } from '../factories'
import { jsonDelete } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql as rawSql } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

describe('DELETE /api/objects/:id on an installed flow', () => {
	let actorId: string
	let workspaceId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	async function seedInstall() {
		const [source] = await db
			.insert(marketplaceLoops)
			.values({
				name: 'Wiki Flow',
				slug: 'wiki-loop',
				description: 'A flow',
				version: '1.0.0',
				useCase: 'knowledge',
			})
			.returning()
		const flowObject = await insertObject(db, workspaceId, actorId, { type: 'loop' })
		const [install] = await db
			.insert(installedLoops)
			.values({
				workspaceId,
				sourceLoopId: source.id,
				objectId: flowObject.id,
				installedVersion: '1.0.0',
			})
			.returning()
		return { flowObject, install }
	}

	it('deletes the flow object and unlinks the install instead of failing on the foreign key', async () => {
		const { flowObject, install } = await seedInstall()
		const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })

		const res = await app.request(jsonDelete(`/api/objects/${flowObject.id}`))

		expect(res.status).toBe(200)
		expect(await db.select().from(objects).where(eq(objects.id, flowObject.id))).toHaveLength(0)
		const [kept] = await db.select().from(installedLoops).where(eq(installedLoops.id, install.id))
		expect(kept?.objectId).toBeNull()
	})

	it('still deletes a plain flow object that has no install', async () => {
		const plain = await insertObject(db, workspaceId, actorId, { type: 'loop' })
		const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })

		const res = await app.request(jsonDelete(`/api/objects/${plain.id}`))

		expect(res.status).toBe(200)
		expect(await db.select().from(objects).where(eq(objects.id, plain.id))).toHaveLength(0)
	})
})
