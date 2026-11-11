/**
 * Owner alerts for runs that die unplanned, against real Postgres.
 * Proves the DB semantics they depend on: one card per owner per cause per UTC day (two
 * replicas send ONE), a different cause or the next day sends again, and a deleted card is
 * not sent again the same day.
 */
import { notifications } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { alertOwnersOncePerDay } from '../../services/run-death-alerts'
import { ensureWorkspaceMember, insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

const day1 = new Date('2026-11-11T10:00:00Z')
const day2 = new Date('2026-11-12T10:00:00Z')

async function setup() {
	const owner = await insertActor(db, { type: 'human' })
	const ownerId = owner?.id as string
	const ws = await insertWorkspace(db, ownerId)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	const agentId = agent?.id as string
	await ensureWorkspaceMember(db, workspaceId, agentId)
	return { ownerId, workspaceId, agentId }
}

async function cards(workspaceId: string) {
	return db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.workspaceId, workspaceId),
				sql`${notifications.metadata}->>'source' = 'run_death_alert'`,
			),
		)
}

const alert = (workspaceId: string, causeKey: string) => ({
	workspaceId,
	causeKey,
	headline: 'A run ended with an error nobody recognised',
	rationale: 'It was not retried. Last line it printed: Segmentation fault.',
})

describe('alertOwnersOncePerDay', () => {
	it('writes one For You card to the owner, and one only when two replicas race', async () => {
		const { ownerId, workspaceId, agentId } = await setup()

		const results = await Promise.all([
			alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1),
			alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1),
		])

		expect(results.filter(Boolean)).toHaveLength(1)
		const rows = await cards(workspaceId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: 'needs_input',
			status: 'pending',
			targetActorId: ownerId,
			sourceActorId: agentId,
			title: 'A run ended with an error nobody recognised',
		})
		expect(rows[0]?.metadata).toMatchObject({
			kind: FOR_YOU_KIND,
			cause_key: 'unclassified:abc',
			alert_day: '2026-11-11',
		})
	})

	it('does not repeat the same cause the same day, even after the card was deleted', async () => {
		const { workspaceId } = await setup()
		await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1)
		const [first] = await cards(workspaceId)
		await db.delete(notifications).where(eq(notifications.id, first?.id as string))

		const again = await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1)

		expect(again).toBe(false)
		expect(await cards(workspaceId)).toHaveLength(0)
	})

	it('sends a different cause the same day, and the same cause the next day', async () => {
		const { workspaceId } = await setup()
		await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1)
		await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:def'), day1)
		await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day2)

		const rows = await cards(workspaceId)
		expect(rows).toHaveLength(3)
	})

	it('sends nothing, and does not throw, when the workspace has no agent to send from', async () => {
		const owner = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, owner?.id as string)
		const workspaceId = ws?.id as string

		const sent = await alertOwnersOncePerDay(db, alert(workspaceId, 'unclassified:abc'), day1)

		expect(sent).toBe(false)
		expect(await cards(workspaceId)).toHaveLength(0)
	})
})
