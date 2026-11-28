import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import {
	actors,
	objects,
	sessionLogs,
	sessions,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertSession,
	insertSessionLog,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const UP = '0179_remove_driver_agent.sql'

async function runMigration() {
	const content = readFileSync(join(drizzleDir, UP), 'utf-8')
	for (const statement of splitStatements(content)) await sql.unsafe(statement)
}

const DRIVER_NAMES = ['Driver', 'Workspace Driver', 'Development Driver']

describe('migration 0179_remove_driver_agent (Integration)', () => {
	it('deletes only the three Driver names with their triggers and sessions, clears the driver slot, and keeps everything else', async () => {
		const owner = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, owner.id)

		const targets = []
		for (const name of DRIVER_NAMES) {
			const agent = await insertActor(db, { type: 'agent', name })
			await ensureWorkspaceMember(db, ws.id, agent.id)
			targets.push(agent)
		}
		// Similar names must survive: the match is exact, not a prefix or case-fold.
		const survivors = []
		for (const name of ['Driver Lead', 'Night Driver', 'driver', 'Development Driver Coach']) {
			const agent = await insertActor(db, { type: 'agent', name })
			await ensureWorkspaceMember(db, ws.id, agent.id)
			survivors.push(agent)
		}

		// A Slack responder seeded at connect time should move to Chief of Staff,
		// not be deleted, so the workspace keeps answering Slack.
		const chief = await insertActor(db, { type: 'agent', name: 'Chief of Staff' })
		await ensureWorkspaceMember(db, ws.id, chief.id)
		const slackTrigger = await insertTrigger(db, ws.id, owner.id, targets[0].id, {
			metadata: { seeded_by: 'slack-integration-default' },
		})

		const targetTrigger = await insertTrigger(db, ws.id, owner.id, targets[0].id)
		const survivorTrigger = await insertTrigger(db, ws.id, owner.id, survivors[0].id)
		const targetSession = await insertSession(db, ws.id, targets[0].id, owner.id)
		const targetLog = await insertSessionLog(db, targetSession.id)
		const survivorSession = await insertSession(db, ws.id, survivors[0].id, owner.id)

		const driven = await insertObject(db, ws.id, targets[0].id, {
			type: 'task',
			status: 'todo',
			driver: targets[0].id,
		})
		const authored = await insertObject(db, ws.id, targets[0].id, {
			type: 'insight',
			status: 'new',
		})
		const untouched = await insertObject(db, ws.id, survivors[0].id, {
			type: 'task',
			status: 'todo',
			driver: survivors[0].id,
		})

		await runMigration()

		const remainingActors = await db
			.select({ id: actors.id, name: actors.name })
			.from(actors)
			.where(inArray(actors.id, [...targets.map((a) => a.id), ...survivors.map((a) => a.id)]))
		expect(remainingActors.map((a) => a.name).sort()).toEqual(
			['Development Driver Coach', 'Driver Lead', 'Night Driver', 'driver'].sort(),
		)

		// Trigger and session of the target are gone; the survivor's are not.
		const remainingTriggers = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(inArray(triggers.id, [targetTrigger.id, survivorTrigger.id]))
		expect(remainingTriggers).toEqual([{ id: survivorTrigger.id }])
		const [movedSlackTrigger] = await db
			.select({ targetActorId: triggers.targetActorId })
			.from(triggers)
			.where(eq(triggers.id, slackTrigger.id))
		expect(movedSlackTrigger?.targetActorId).toBe(chief.id)

		const remainingSessions = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(inArray(sessions.id, [targetSession.id, survivorSession.id]))
		expect(remainingSessions).toEqual([{ id: survivorSession.id }])

		const remainingLogs = await db
			.select({ id: sessionLogs.id })
			.from(sessionLogs)
			.where(eq(sessionLogs.id, targetLog.id))
		expect(remainingLogs).toEqual([])

		// The driver slot is cleared, authored rows are handed to the workspace owner,
		// and objects that never named the Driver are untouched.
		const [drivenAfter] = await db.select().from(objects).where(eq(objects.id, driven.id))
		expect(drivenAfter.driver).toBeNull()
		const [authoredAfter] = await db.select().from(objects).where(eq(objects.id, authored.id))
		expect(authoredAfter.createdBy).toBe(owner.id)
		const [untouchedAfter] = await db.select().from(objects).where(eq(objects.id, untouched.id))
		expect(untouchedAfter.driver).toBe(survivors[0].id)
		expect(untouchedAfter.createdBy).toBe(survivors[0].id)

		// Target memberships are gone; survivor memberships stay.
		const remainingMembers = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				inArray(workspaceMembers.actorId, [
					...targets.map((a) => a.id),
					...survivors.map((a) => a.id),
				]),
			)
		expect(new Set(remainingMembers.map((m) => m.actorId))).toEqual(
			new Set(survivors.map((a) => a.id)),
		)

		// Safe to run twice: the second pass finds no targets and changes nothing.
		await expect(runMigration()).resolves.toBeUndefined()
	})
})
