import { randomUUID } from 'node:crypto'
import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { AwaitingDeployAgingSweep } from '../../services/awaiting-deploy-aging-sweep'
import { attributeDeploymentToObject } from '../../services/deploy-attribution'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Real-Postgres verifier for T4. Every assertion reads back from the DB —
 * digest emission is the T4 measurement gate, and the follow-through path
 * from T3 attribution has to be observed against the same table T3 writes.
 */

const DAY_MS = 24 * 60 * 60 * 1000

function isoDaysAgo(days: number, jitterHours = 1): string {
	// Nudge slightly earlier than the exact 7-day cutoff so a >= 7d bet is
	// unambiguously stale.
	return new Date(Date.now() - days * DAY_MS - jitterHours * 60 * 60 * 1000).toISOString()
}

function shaOf(prefix: string): string {
	return (prefix + '0'.repeat(40)).slice(0, 40)
}

async function seedOpenUmbrellaPr(
	workspaceId: string,
	actorId: string,
	prHeadRef: string,
	prNumber: number,
	prUrl: string,
): Promise<void> {
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'opened',
		entityType: 'github.pull_request',
		entityId: randomUUID(),
		data: {
			pr_number: prNumber,
			pr_title: 'Umbrella',
			pr_url: prUrl,
			pr_head_ref: prHeadRef,
			pr_head_sha: shaOf(`h${prNumber}`),
			pr_base_branch: 'main',
			merge_commit_sha: null,
		},
	})
}

async function seedMergedUmbrellaPr(
	workspaceId: string,
	actorId: string,
	prHeadRef: string,
	prNumber: number,
	mergeSha: string,
): Promise<void> {
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'merged',
		entityType: 'github.pull_request',
		entityId: randomUUID(),
		data: {
			pr_number: prNumber,
			pr_title: 'Umbrella',
			pr_url: `https://github.com/example/repo/pull/${prNumber}`,
			pr_head_ref: prHeadRef,
			pr_head_sha: shaOf(`h${prNumber}`),
			pr_base_branch: 'main',
			merge_commit_sha: mergeSha,
		},
	})
}

async function readDigestEvents(workspaceId: string) {
	return db
		.select({
			id: events.id,
			entityType: events.entityType,
			entityId: events.entityId,
			action: events.action,
			data: events.data,
		})
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'deploy_digest_posted')))
}

describe('AwaitingDeployAgingSweep (T4)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	// AC-U2 + AC-U3 core case: three seeded bets — an 8-day stale bet with no
	// PR context, a 5-day bet that is not yet stale, and a bet whose umbrella
	// PR never merged. One tick must produce exactly one digest, with entries
	// for the 8-day bet and the umbrella-blocked bet, the 5-day bet absent,
	// and the umbrella-blocked entry naming the unmerged PR.
	it('emits one digest that includes stale bets and names the unmerged umbrella PR as blocker', async () => {
		const stale = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Eight-day stale bet',
			status: 'active',
			metadata: {
				awaiting_deploy: true,
				live_started_at: isoDaysAgo(8),
			},
		})
		const notStale = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Five-day bet',
			status: 'active',
			metadata: {
				awaiting_deploy: true,
				live_started_at: isoDaysAgo(5),
			},
		})
		const umbrellaBlocked = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Umbrella-blocked bet',
			status: 'active',
			metadata: {
				awaiting_deploy: true,
				live_started_at: isoDaysAgo(10),
				branch: 'bet/umbrella-blocked',
			},
		})
		await seedOpenUmbrellaPr(
			workspaceId,
			actorId,
			'bet/umbrella-blocked',
			931,
			'https://github.com/example/repo/pull/931',
		)

		const sweep = new AwaitingDeployAgingSweep(db)
		const summaries = await sweep.tick()

		expect(summaries).toHaveLength(1)
		expect(summaries[0]?.workspaceId).toBe(workspaceId)
		expect(summaries[0]?.entryCount).toBe(2)

		const digestRows = await readDigestEvents(workspaceId)
		expect(digestRows).toHaveLength(1)

		const digest = digestRows[0]
		expect(digest?.entityType).toBe('workspace')
		expect(digest?.entityId).toBe(workspaceId)
		const data = digest?.data as { content: string; entries: Array<Record<string, unknown>> }
		const betIds = data.entries.map((e) => e.bet_id)
		expect(new Set(betIds)).toEqual(new Set([stale.id, umbrellaBlocked.id]))
		expect(betIds).not.toContain(notStale.id)

		const umbrellaEntry = data.entries.find((e) => e.bet_id === umbrellaBlocked.id)
		expect(umbrellaEntry?.blocker).toContain('PR #931')
		expect(umbrellaEntry?.blocker).toContain('https://github.com/example/repo/pull/931')
		expect(umbrellaEntry?.blocker).toContain('not merged')

		const staleEntry = data.entries.find((e) => e.bet_id === stale.id)
		expect(staleEntry?.blocker).toContain('deployment_status')
		expect(String(data.content)).toContain('Unconfirmed-deploy digest')
	})

	// The follow-through: once T3 attribution clears `awaiting_deploy` on a
	// bet, the next sweep must not resurface it. Runs the sweep, invokes the
	// real T3 path with a matching push event, and reruns the sweep.
	it('drops a bet from subsequent digests once T3 attribution clears awaiting_deploy', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Follow-through bet',
			status: 'active',
			metadata: {
				awaiting_deploy: true,
				live_started_at: isoDaysAgo(9),
				branch: 'bet/follow-through',
			},
		})

		const sweep = new AwaitingDeployAgingSweep(db)
		const first = await sweep.tick()
		expect(first).toHaveLength(1)
		expect(first[0]?.entryCount).toBe(1)

		// Seed the push event and run the real T3 attribution path — this is
		// the "T3's path" the DoD names.
		const sha = shaOf('ft')
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'pushed',
			entityType: 'github.push',
			entityId: randomUUID(),
			data: { ref: 'refs/heads/bet/follow-through', head_commit_sha: sha, commits_count: 1 },
		})
		const attribution = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: new Date().toISOString(),
			deploymentRef: 'refs/heads/main',
		})
		expect(attribution.matched).toBe(true)
		expect(attribution.objectId).toBe(bet.id)

		const [after] = await db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, bet.id))
		const meta = (after?.metadata ?? {}) as Record<string, unknown>
		expect(meta.awaiting_deploy).toBe(false)

		const second = await sweep.tick()
		expect(second).toHaveLength(0)

		const digestRows = await readDigestEvents(workspaceId)
		expect(digestRows).toHaveLength(1)
	})

	// The digest is workspace-scoped: two workspaces with stale bets get one
	// digest each, and the entries do not cross workspace boundaries.
	it('scopes each digest to its workspace and does not leak entries across workspaces', async () => {
		const otherWs = await insertWorkspace(db, actorId)
		const betA = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'A',
			status: 'active',
			metadata: { awaiting_deploy: true, live_started_at: isoDaysAgo(8) },
		})
		const betB = await insertObject(db, otherWs.id, actorId, {
			type: 'bet',
			title: 'B',
			status: 'active',
			metadata: { awaiting_deploy: true, live_started_at: isoDaysAgo(9) },
		})

		const sweep = new AwaitingDeployAgingSweep(db)
		const summaries = await sweep.tick()

		expect(summaries).toHaveLength(2)
		const bothWorkspaces = new Set(summaries.map((s) => s.workspaceId))
		expect(bothWorkspaces).toEqual(new Set([workspaceId, otherWs.id]))

		const digestA = (await readDigestEvents(workspaceId))[0]
		const digestB = (await readDigestEvents(otherWs.id))[0]
		const entriesA = (digestA?.data as { entries: Array<Record<string, unknown>> }).entries
		const entriesB = (digestB?.data as { entries: Array<Record<string, unknown>> }).entries

		expect(entriesA.map((e) => e.bet_id)).toEqual([betA.id])
		expect(entriesB.map((e) => e.bet_id)).toEqual([betB.id])
	})

	// A stale bet whose umbrella PR is merged (merge_commit_sha set) but whose
	// deploy never landed keeps the generic missing-deploy blocker — the
	// unmerged-umbrella label is reserved for the actually-unmerged case.
	it('does not label a merged umbrella PR as unmerged blocker', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Merged umbrella',
			status: 'active',
			metadata: {
				awaiting_deploy: true,
				live_started_at: isoDaysAgo(8),
				branch: 'bet/merged-umbrella',
			},
		})
		await seedMergedUmbrellaPr(workspaceId, actorId, 'bet/merged-umbrella', 42, shaOf('m'))

		const sweep = new AwaitingDeployAgingSweep(db)
		const summaries = await sweep.tick()

		expect(summaries).toHaveLength(1)
		const digest = (await readDigestEvents(workspaceId))[0]
		const entries = (digest?.data as { entries: Array<Record<string, unknown>> }).entries
		const entry = entries.find((e) => e.bet_id === bet.id)
		expect(entry?.blocker).not.toContain('not merged')
		expect(entry?.blocker).toContain('deployment_status')
	})

	// Emits nothing when there are no stale bets — noise budget matters, the
	// digest surface should only appear when there's actually something to
	// look at.
	it('emits nothing when there are no stale awaiting_deploy bets', async () => {
		await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Fresh',
			status: 'active',
			metadata: { awaiting_deploy: true, live_started_at: isoDaysAgo(2) },
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'Already deployed',
			status: 'active',
			metadata: {
				awaiting_deploy: false,
				live_started_at: isoDaysAgo(30),
				deployed_at: isoDaysAgo(1),
			},
		})

		const sweep = new AwaitingDeployAgingSweep(db)
		const summaries = await sweep.tick()

		expect(summaries).toHaveLength(0)
		const digestRows = await readDigestEvents(workspaceId)
		expect(digestRows).toHaveLength(0)
	})
})
