import { objects, relationships } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	COMPANY_TARGET_DEADLINE,
	COMPANY_TARGET_TITLE,
	moveTargetsToObjects,
} from '../../services/move-targets-to-objects'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function targetObjects(workspaceId: string) {
	return db
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'target')))
}

async function edges(type: string) {
	return db.select().from(relationships).where(eq(relationships.type, type))
}

describe('Move flow target rows into target objects', () => {
	let workspaceId: string
	let owner: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['work', 'targets'] },
		})
		workspaceId = ws.id
		owner = (await insertActor(db, { type: 'agent', name: 'Owner' })).id
	})

	async function makeLoop(title: string, targets: unknown[]) {
		return insertObject(db, workspaceId, getTestActorId(), {
			type: 'loop',
			title,
			status: 'draft',
			metadata: { targets },
		})
	}

	it('creates one target object per row, linked to its flow, and a second run creates nothing', async () => {
		const loop = await makeLoop('Posts', [
			{ label: 'Posts published', source: 'posts', actual: 3, target: 8, ownerActorId: owner },
			{ label: 'Replies answered', source: 'metric:inbox.replies', actual: 0, target: 5 },
		])

		const plan = await moveTargetsToObjects(db, { workspaceId, dryRun: true })
		expect(plan.flowTargetsToCreate.map((t) => t.label)).toEqual([
			'Posts published',
			'Replies answered',
		])
		expect(await targetObjects(workspaceId)).toHaveLength(0)

		await moveTargetsToObjects(db, { workspaceId })
		const created = await targetObjects(workspaceId)
		expect(created).toHaveLength(2)
		const posts = created.find((o) => o.title === 'Posts published')
		expect(posts).toMatchObject({
			status: 'open',
			driver: owner,
			metadata: { source: 'posts', actual: 3, target: 8 },
		})
		const links = (await edges('target_of')).filter((e) => e.targetId === loop.id)
		expect(links).toHaveLength(2)

		// Old rows stay where they are.
		const [after] = await db.select().from(objects).where(eq(objects.id, loop.id))
		expect((after?.metadata as { targets: unknown[] }).targets).toHaveLength(2)

		const again = await moveTargetsToObjects(db, { workspaceId })
		expect(again).toMatchObject({
			flowTargetsExisting: 2,
			companyTargetsToCreate: 0,
			companyLinksToCreate: 0,
		})
		expect(again.flowTargetsToCreate).toHaveLength(0)
		expect(await targetObjects(workspaceId)).toHaveLength(2)
		expect((await edges('target_of')).filter((e) => e.targetId === loop.id)).toHaveLength(2)
	})

	it('keeps the order of the old rows through link time', async () => {
		const loop = await makeLoop(
			'Order',
			['c', 'a', 'b'].map((label) => ({ label, source: label, actual: 1, target: 2 })),
		)
		await moveTargetsToObjects(db, { workspaceId })
		const links = (await edges('target_of'))
			.filter((e) => e.targetId === loop.id)
			.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
		const titles = []
		for (const l of links) {
			const [o] = await db.select().from(objects).where(eq(objects.id, l.sourceId))
			titles.push(o?.title)
		}
		expect(titles).toEqual(['c', 'a', 'b'])
	})

	it('leaves one company target for 10 paying customers, linked to the flow targets under it', async () => {
		const sales = await makeLoop('Sales', [
			{
				label: '10 paying customers',
				source: 'Stripe',
				actual: 0,
				target: 10,
				ownerActorId: owner,
			},
			{ label: 'Meetings booked', source: 'meetings', actual: 1, target: 3 },
		])
		const other = await makeLoop('Founder-led sales', [
			{ label: '10 paying orgs', source: 'Stripe', actual: 0, target: 10 },
		])

		const first = await moveTargetsToObjects(db, { workspaceId })
		expect(first).toMatchObject({ companyTargetsToCreate: 1, companyLinksToCreate: 2 })

		const all = await targetObjects(workspaceId)
		const company = all.filter(
			(o) => o.title === COMPANY_TARGET_TITLE && o.metadata && 'deadline' in (o.metadata as object),
		)
		expect(company).toHaveLength(1)
		expect(company[0]?.metadata).toMatchObject({ deadline: COMPANY_TARGET_DEADLINE, target: 10 })
		// The company target has no flow.
		const flowLinks = (await edges('target_of')).filter((e) => e.sourceId === company[0]?.id)
		expect(flowLinks).toHaveLength(0)

		const down = (await edges('breaks_into')).filter((e) => e.sourceId === company[0]?.id)
		expect(down).toHaveLength(2)
		const downTitles = []
		for (const e of down) {
			const [o] = await db.select().from(objects).where(eq(objects.id, e.targetId))
			downTitles.push(o?.title)
		}
		expect(downTitles.sort()).toEqual(['10 paying customers', '10 paying orgs'])
		// "Meetings booked" does not serve it.
		expect(all.some((o) => o.title === 'Meetings booked')).toBe(true)
		expect(down.some((e) => e.targetId === sales.id || e.targetId === other.id)).toBe(false)

		const second = await moveTargetsToObjects(db, { workspaceId })
		expect(second).toMatchObject({ companyTargetsToCreate: 0, companyLinksToCreate: 0 })
		expect(await targetObjects(workspaceId)).toHaveLength(all.length)
	})

	it('uses the deadline it is given', async () => {
		await makeLoop('Sales', [{ label: '10 paying customers', source: 's', actual: 0, target: 10 }])
		await moveTargetsToObjects(db, { workspaceId, companyDeadline: '2027-02-28' })
		const company = (await targetObjects(workspaceId)).find(
			(o) => o.metadata && 'deadline' in (o.metadata as object),
		)
		expect(company?.metadata).toMatchObject({ deadline: '2027-02-28' })
	})

	it('skips rows that fail the shape check and workspaces without the extension', async () => {
		await makeLoop('Mixed', [
			{ label: 'Good', source: 's', actual: 1, target: 2 },
			{ label: 'Bad', source: 's', actual: 'one', target: 2 },
		])
		const plain = await insertWorkspace(db, getTestActorId(), {
			settings: { enabled_modules: ['work'] },
		})
		await insertObject(db, plain.id, getTestActorId(), {
			type: 'loop',
			status: 'draft',
			metadata: { targets: [{ label: 'Elsewhere', source: 's', actual: 1, target: 2 }] },
		})

		const result = await moveTargetsToObjects(db, {})
		expect(result.invalidRows.map((r) => r.label)).toEqual(['Bad'])
		expect(result.skippedWorkspaceIds).toContain(plain.id)
		expect((await targetObjects(workspaceId)).map((o) => o.title)).toEqual(['Good'])
		expect(await targetObjects(plain.id)).toHaveLength(0)
	})
})
