import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { events } from '@maskin/db/schema'
import { unreadCandidateEntityIds } from '../../lib/unread-candidates'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * comment_mentions answers "which entities can have an unread mention for this person?" and is
 * filled by a trigger on events (migration 0171), with a one-time backfill (0172). The old answer
 * was a scan of every commented event, so these tests compare against that rule: a comment by
 * someone else with the person's id in data.mentions.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKFILL = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0172_backfill_comment_mentions.sql',
)

async function comment(workspaceId: string, actorId: string, entityId: string, data: unknown) {
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'commented',
		entityType: 'object',
		entityId,
		data: data as Record<string, unknown>,
	})
}

async function rowsFor(workspaceId: string, actorId: string) {
	const rows = await sql<{ entity_id: string }[]>`
		SELECT entity_id FROM comment_mentions
		WHERE workspace_id = ${workspaceId} AND actor_id = ${actorId}
		ORDER BY entity_id
	`
	return rows.map((r) => r.entity_id)
}

describe('comment_mentions', () => {
	it('records a mention as the comment is saved, with no rebuild', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)
		const entity = randomUUID()

		expect(await unreadCandidateEntityIds(db, ws.id, me)).toEqual([])

		await comment(ws.id, author, entity, { content: 'hi', mentions: [me] })

		expect(await unreadCandidateEntityIds(db, ws.id, me)).toEqual([entity])
	})

	it('lists an entity once however many comments mention the person', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)
		const entity = randomUUID()

		await comment(ws.id, author, entity, { mentions: [me, me] })
		await comment(ws.id, author, entity, { mentions: [me] })

		expect(await rowsFor(ws.id, me)).toEqual([entity])
	})

	it('ignores a comment that mentions its own author', async () => {
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, me)

		await comment(ws.id, me, randomUUID(), { mentions: [me] })

		expect(await rowsFor(ws.id, me)).toEqual([])
	})

	it('keeps one workspace, and one person, apart from another', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const other = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)
		const otherWs = await insertWorkspace(db, author)
		const entity = randomUUID()

		await comment(ws.id, author, entity, { mentions: [other] })
		await comment(otherWs.id, author, randomUUID(), { mentions: [me] })

		expect(await unreadCandidateEntityIds(db, ws.id, me)).toEqual([])
	})

	it('never fails a comment because of what is in data.mentions', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)
		const entity = randomUUID()

		await comment(ws.id, author, entity, {
			mentions: ['not-a-uuid', 5, null, '', { a: 1 }, me],
		})
		await comment(ws.id, author, randomUUID(), { mentions: me })
		await comment(ws.id, author, randomUUID(), { mentions: null })
		await comment(ws.id, author, randomUUID(), { content: 'no mentions key' })
		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: author,
			action: 'commented',
			entityType: 'object',
			entityId: randomUUID(),
			data: null,
		})

		expect(await rowsFor(ws.id, me)).toEqual([entity])
	})

	it('does not record a mention on an event that is not a comment', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)

		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: author,
			action: 'updated',
			entityType: 'object',
			entityId: randomUUID(),
			data: { mentions: [me] },
		})

		expect(await rowsFor(ws.id, me)).toEqual([])
	})

	it('backfills comments written before the trigger, and a second run adds nothing', async () => {
		const author = getTestActorId()
		const me = (await insertActor(db)).id
		const ws = await insertWorkspace(db, author)
		const old = randomUUID()
		const newer = randomUUID()

		await sql`ALTER TABLE events DISABLE TRIGGER events_comment_mentions`
		try {
			await comment(ws.id, author, old, { mentions: [me, 'junk'] })
			await comment(ws.id, me, randomUUID(), { mentions: [me] })
		} finally {
			await sql`ALTER TABLE events ENABLE TRIGGER events_comment_mentions`
		}
		await comment(ws.id, author, newer, { mentions: [me] })
		expect(await rowsFor(ws.id, me)).toEqual([newer])

		const statements = splitStatements(readFileSync(BACKFILL, 'utf-8'))
		for (const run of [1, 2]) {
			for (const statement of statements) await sql.unsafe(statement)
			expect(await rowsFor(ws.id, me), `run ${run}`).toEqual([old, newer].sort())
		}
	})
})
