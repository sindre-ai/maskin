import { events, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	HEARTBEAT_METADATA_KEY,
	HEARTBEAT_PROMPT,
	backfillDefaultHeartbeats,
	heartbeatCronExpression,
} from '../../services/default-heartbeat'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function addMember(workspaceId: string, actorId: string, role = 'member') {
	await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
}

async function heartbeatsFor(actorId: string) {
	return db.select().from(triggers).where(eq(triggers.targetActorId, actorId))
}

describe('Default Heartbeat backfill', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	it('gives each agent one daily Heartbeat and a second run changes nothing', async () => {
		const first = await insertActor(db, { type: 'agent', name: 'First agent' })
		const second = await insertActor(db, { type: 'agent', name: 'Second agent' })
		await addMember(workspaceId, first.id)
		await addMember(workspaceId, second.id)

		const run1 = await backfillDefaultHeartbeats(db, { workspaceId })
		expect(run1).toMatchObject({ eligible: 2, created: 2, reworded: 0 })

		const [row] = await heartbeatsFor(first.id)
		expect(row).toMatchObject({
			workspaceId,
			name: 'Heartbeat',
			type: 'cron',
			enabled: true,
			actionPrompt: HEARTBEAT_PROMPT,
			config: { expression: heartbeatCronExpression(first.id) },
		})
		expect(await heartbeatsFor(second.id)).toHaveLength(1)

		const run2 = await backfillDefaultHeartbeats(db, { workspaceId })
		expect(run2).toMatchObject({ eligible: 2, created: 0, reworded: 0 })
		expect(await heartbeatsFor(first.id)).toHaveLength(1)
		expect(await heartbeatsFor(second.id)).toHaveLength(1)
	})

	it('records a created event so the trigger runner schedules the Heartbeat', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Scheduled agent' })
		await addMember(workspaceId, agent.id)

		await backfillDefaultHeartbeats(db, { workspaceId })

		const [row] = await heartbeatsFor(agent.id)
		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'trigger'), eq(events.entityId, row.id)))
		expect(event).toMatchObject({ action: 'created', workspaceId })
	})

	it('skips humans, integration actors, retired agents and system-role members', async () => {
		const human = await insertActor(db, { type: 'human', name: 'A person' })
		const integration = await insertActor(db, { type: 'system', name: 'Slack' })
		const retired = await insertActor(db, {
			type: 'agent',
			name: 'Old agent',
			description: 'RETIRED: replaced by another agent',
		})
		const systemRole = await insertActor(db, { type: 'agent', name: 'Integration-role agent' })
		const live = await insertActor(db, { type: 'agent', name: 'Live agent' })
		await addMember(workspaceId, human.id)
		await addMember(workspaceId, integration.id, 'system')
		await addMember(workspaceId, retired.id)
		await addMember(workspaceId, systemRole.id, 'system')
		await addMember(workspaceId, live.id)

		const result = await backfillDefaultHeartbeats(db, { workspaceId })

		expect(result.created).toBe(1)
		for (const skipped of [human, integration, retired, systemRole]) {
			expect(await heartbeatsFor(skipped.id)).toHaveLength(0)
		}
		expect(await heartbeatsFor(live.id)).toHaveLength(1)
	})

	it('writes nothing on a dry run', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Dry run agent' })
		await addMember(workspaceId, agent.id)

		const result = await backfillDefaultHeartbeats(db, { workspaceId, dryRun: true })

		expect(result.created).toBe(1)
		expect(await heartbeatsFor(agent.id)).toHaveLength(0)
	})

	it('only touches the workspace it was asked about', async () => {
		const other = await insertWorkspace(db, getTestActorId())
		const here = await insertActor(db, { type: 'agent', name: 'Agent here' })
		const there = await insertActor(db, { type: 'agent', name: 'Agent there' })
		await addMember(workspaceId, here.id)
		await addMember(other.id, there.id)

		await backfillDefaultHeartbeats(db, { workspaceId })

		expect(await heartbeatsFor(here.id)).toHaveLength(1)
		expect(await heartbeatsFor(there.id)).toHaveLength(0)
	})

	it('leaves a disabled Heartbeat disabled and does not add a second one', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Paused agent' })
		await addMember(workspaceId, agent.id)
		await backfillDefaultHeartbeats(db, { workspaceId })
		const [row] = await heartbeatsFor(agent.id)
		await db.update(triggers).set({ enabled: false }).where(eq(triggers.id, row.id))

		await backfillDefaultHeartbeats(db, { workspaceId })

		const rows = await heartbeatsFor(agent.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.enabled).toBe(false)
	})

	it('ignores a hand-made trigger that merely shares the name', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Has own heartbeat' })
		await addMember(workspaceId, agent.id)
		await db.insert(triggers).values({
			workspaceId,
			name: 'Heartbeat',
			type: 'cron',
			config: { expression: '0 9 * * *' },
			actionPrompt: 'My own heartbeat',
			targetActorId: agent.id,
			createdBy: getTestActorId(),
		})

		const result = await backfillDefaultHeartbeats(db, { workspaceId })

		expect(result.created).toBe(1)
		expect(await heartbeatsFor(agent.id)).toHaveLength(2)
	})

	describe('rolling out a new wording', () => {
		async function setStoredPrompt(triggerId: string, prompt: string, recordedAs: string) {
			const { createHash } = await import('node:crypto')
			await db
				.update(triggers)
				.set({
					actionPrompt: prompt,
					metadata: {
						[HEARTBEAT_METADATA_KEY]: {
							prompt_sha: createHash('sha256').update(recordedAs).digest('hex'),
						},
					},
				})
				.where(eq(triggers.id, triggerId))
		}

		it('rewrites a Heartbeat still carrying the wording that was last written', async () => {
			const agent = await insertActor(db, { type: 'agent', name: 'Old wording agent' })
			await addMember(workspaceId, agent.id)
			await backfillDefaultHeartbeats(db, { workspaceId })
			const [row] = await heartbeatsFor(agent.id)
			await setStoredPrompt(row.id, 'Old wording', 'Old wording')

			const result = await backfillDefaultHeartbeats(db, { workspaceId })

			expect(result).toMatchObject({ created: 0, reworded: 1 })
			const [after] = await heartbeatsFor(agent.id)
			expect(after?.actionPrompt).toBe(HEARTBEAT_PROMPT)
			const [event] = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityType, 'trigger'),
						eq(events.entityId, row.id),
						eq(events.action, 'updated'),
					),
				)
			expect(event).toBeTruthy()

			const again = await backfillDefaultHeartbeats(db, { workspaceId })
			expect(again.reworded).toBe(0)
		})

		it('leaves a prompt a person has edited as they wrote it', async () => {
			const agent = await insertActor(db, { type: 'agent', name: 'Edited prompt agent' })
			await addMember(workspaceId, agent.id)
			await backfillDefaultHeartbeats(db, { workspaceId })
			const [row] = await heartbeatsFor(agent.id)
			await setStoredPrompt(row.id, 'Hand-edited wording', 'Old wording')

			const result = await backfillDefaultHeartbeats(db, { workspaceId })

			expect(result.reworded).toBe(0)
			const [after] = await heartbeatsFor(agent.id)
			expect(after?.actionPrompt).toBe('Hand-edited wording')
		})
	})
})

describe('heartbeatCronExpression', () => {
	it('puts every agent at a minute between 01:00 and 03:59 UTC, once a day', () => {
		const seen = new Set<string>()
		for (let i = 0; i < 500; i++) {
			const id = `${(i * 7919 + 12345).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
			const expression = heartbeatCronExpression(id)
			const match = expression.match(/^(\d{1,2}) ([123]) \* \* \*$/)
			expect(match, expression).not.toBeNull()
			expect(Number(match?.[1])).toBeLessThan(60)
			seen.add(expression)
		}
		// 500 ids land on many different minutes, so agents do not all fire together.
		expect(seen.size).toBeGreaterThan(100)
	})

	it('gives the same agent the same time every day', () => {
		const id = '4b72d1b5-0324-4171-ac45-5c0d5cc9e7ec'
		expect(heartbeatCronExpression(id)).toBe(heartbeatCronExpression(id))
	})
})
