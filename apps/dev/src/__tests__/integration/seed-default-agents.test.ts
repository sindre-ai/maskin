import { actors, triggers, workspaceMembers } from '@maskin/db/schema'
import {
	DEFAULT_AGENTS,
	STRATEGIST_DEFAULT,
	STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME,
} from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { seedDefaultAgents } from '../../services/seed-default-agents'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

describe('seedDefaultAgents (integration)', () => {
	it('seats Driver, Coach, Strategist as workspace members with real FK constraints', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const names = DEFAULT_AGENTS.map((a) => a.name)

		await seedDefaultAgents(db, ws.id, getTestActorId())

		const seededActors = await db
			.select({ id: actors.id, name: actors.name, isSystem: actors.isSystem, type: actors.type })
			.from(actors)
			.where(inArray(actors.name, names))

		expect(seededActors).toHaveLength(3)
		expect(seededActors.map((a) => a.name).sort()).toEqual(['Coach', 'Driver', 'Strategist'])
		expect(seededActors.every((a) => a.isSystem === true)).toBe(true)
		expect(seededActors.every((a) => a.type === 'agent')).toBe(true)

		// Verify all three are actual workspace members (FK: workspaceMembers.actorId → actors.id)
		const seededIds = new Set(seededActors.map((a) => a.id))
		const memberRows = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, ws.id))

		expect(memberRows.filter((m) => seededIds.has(m.actorId))).toHaveLength(3)
	})

	it('creates the Strategist research-on-signup trigger targeting the correct actor id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedDefaultAgents(db, ws.id, getTestActorId())

		const [trigger] = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, ws.id),
					eq(triggers.name, STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME),
				),
			)

		expect(trigger).toBeDefined()
		expect(trigger.type).toBe('event')
		expect(trigger.enabled).toBe(true)

		// Verify targetActorId references the Strategist actor that was just inserted
		const [strategist] = await db
			.select({ id: actors.id })
			.from(actors)
			.where(eq(actors.name, STRATEGIST_DEFAULT.name))

		expect(strategist).toBeDefined()
		expect(trigger.targetActorId).toBe(strategist.id)
	})

	it('is idempotent: a second call produces no duplicate actors, members, or triggers', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const names = DEFAULT_AGENTS.map((a) => a.name)

		await seedDefaultAgents(db, ws.id, getTestActorId())
		await seedDefaultAgents(db, ws.id, getTestActorId())

		const actorRows = await db
			.select({ name: actors.name })
			.from(actors)
			.where(inArray(actors.name, names))

		expect(actorRows).toHaveLength(3)

		const triggerRows = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, ws.id),
					eq(triggers.name, STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME),
				),
			)

		expect(triggerRows).toHaveLength(1)
	})

	it('skips an already-seated agent without triggering a unique-constraint violation', async () => {
		const ws = await insertWorkspace(db, getTestActorId())

		// Pre-seat Driver so it already exists as a workspace member before seeding
		const [existing] = await db
			.insert(actors)
			.values({
				name: 'Driver',
				type: 'agent',
				isSystem: true,
				apiKey: 'ank_preexisting_driver_key',
				createdBy: getTestActorId(),
			})
			.returning()
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: existing.id,
			role: 'member',
		})

		// Must not throw even though Driver is already seated
		await expect(seedDefaultAgents(db, ws.id, getTestActorId())).resolves.toBeUndefined()

		// Exactly one Driver member row in this workspace
		const driverMembers = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, ws.id), eq(actors.name, 'Driver')))

		expect(driverMembers).toHaveLength(1)
	})
})
