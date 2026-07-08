import { randomUUID } from 'node:crypto'
import { events, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { attributeDeploymentToObject } from '../../services/deploy-attribution'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Real-Postgres verifier for T3 attribution. Every assertion reads the row
 * back from the DB — a mocked service return can't catch the transaction /
 * JSONB / row-lock semantics this bet depends on (per the measurement gate
 * cited in the T3 brief).
 */

function shaOf(prefix: string): string {
	return (prefix + '0'.repeat(40)).slice(0, 40)
}

async function seedPushEvent(
	workspaceId: string,
	actorId: string,
	sha: string,
	ref: string,
): Promise<void> {
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'pushed',
		entityType: 'github.push',
		entityId: randomUUID(),
		data: {
			ref,
			head_commit_sha: sha,
			head_commit: 'msg',
			commits_count: 1,
		},
	})
}

async function seedMergedPrEvent(
	workspaceId: string,
	actorId: string,
	mergeSha: string,
	prHeadRef: string,
	prHeadSha?: string,
): Promise<void> {
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'merged',
		entityType: 'github.pull_request',
		entityId: randomUUID(),
		data: {
			pr_number: 42,
			pr_title: 'T',
			pr_head_sha: prHeadSha ?? shaOf('h'),
			pr_head_ref: prHeadRef,
			pr_base_branch: 'main',
			merge_commit_sha: mergeSha,
		},
	})
}

async function readMetadata(id: string): Promise<Record<string, unknown> | null> {
	const [row] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(eq(objects.id, id))
		.limit(1)
	return (row?.metadata ?? null) as Record<string, unknown> | null
}

describe('deploy-attribution (T3)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	// Pass 1 via a stored `github.push` event whose `head_commit_sha` equals the
	// deployment payload's SHA. Attribution should read the branch from the
	// event's `ref`, find the bet with `metadata.branch = <branch>`, and set
	// `deployed_at` + `awaiting_deploy = false` in a single write.
	it('Pass 1 — attributes a deploy to the bet via a stored push event and writes atomically', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'push-bet',
			status: 'active',
			metadata: { branch: 'bet/push-bet', awaiting_deploy: true },
		})
		const sha = shaOf('a')
		await seedPushEvent(workspaceId, actorId, sha, 'refs/heads/bet/push-bet')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T09:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.objectId).toBe(bet.id)
		expect(result.objectType).toBe('bet')
		expect(result.reason).toBe('pass1_push')

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-07-01T09:00:00.000Z')
		expect(metadata?.awaiting_deploy).toBe(false)
		expect(metadata?.branch).toBe('bet/push-bet')
	})

	// Pass 1 via a stored `github.pull_request` merged event whose
	// `merge_commit_sha` equals the deployment payload's SHA. Attribution
	// should read the branch from the event's `pr_head_ref` and update the
	// matching bet.
	it('Pass 1 — attributes a deploy to the bet via a stored merged PR event', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'pr-bet',
			status: 'active',
			metadata: { branch: 'bet/pr-bet', awaiting_deploy: true },
		})
		const mergeSha = shaOf('b')
		await seedMergedPrEvent(workspaceId, actorId, mergeSha, 'bet/pr-bet')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha: mergeSha,
			deployedAt: '2026-07-01T10:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.reason).toBe('pass1_pr_merge')

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-07-01T10:00:00.000Z')
		expect(metadata?.awaiting_deploy).toBe(false)
	})

	// Squash-merge to `main`: BOTH a `github.push` event (ref=refs/heads/main,
	// head_commit_sha=M) AND a `github.pull_request` merged event
	// (merge_commit_sha=M, pr_head_ref=bet/source) land for the same SHA.
	// The bet holds the source branch, so only the PR event resolves — Pass 1
	// must prefer the PR row over the push row. Seeding push first exercises
	// the non-deterministic OR-query failure mode the earlier implementation had.
	it('Pass 1 — prefers PR merged event over push when both share the deploy SHA', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'squash-bet',
			status: 'active',
			metadata: { branch: 'bet/squash', awaiting_deploy: true },
		})
		const sha = shaOf('s')
		await seedPushEvent(workspaceId, actorId, sha, 'refs/heads/main')
		await seedMergedPrEvent(workspaceId, actorId, sha, 'bet/squash')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T18:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.objectId).toBe(bet.id)
		expect(result.reason).toBe('pass1_pr_merge')

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-07-01T18:00:00.000Z')
		expect(metadata?.awaiting_deploy).toBe(false)
	})

	// Pass 2(a) — when no `push`/`pull_request` event stores the SHA, fall back
	// to matching the deployment payload's ref against `bet.metadata.branch`.
	it('Pass 2 — falls back to bet.metadata.branch when no merge event stores the SHA', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'branch-bet',
			status: 'active',
			metadata: { branch: 'bet/direct-branch', awaiting_deploy: true },
		})

		const sha = shaOf('c')
		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T11:00:00.000Z',
			deploymentRef: 'refs/heads/bet/direct-branch',
		})

		expect(result.matched).toBe(true)
		expect(result.reason).toBe('pass2_branch')

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-07-01T11:00:00.000Z')
		expect(metadata?.awaiting_deploy).toBe(false)
	})

	// Pass 2(b) — when Pass 1 and Pass 2(a) both miss, look up a stored PR event
	// whose `pr_head_sha` equals the deploy SHA (a direct-branch deploy where
	// the deployed commit is the PR's head, not its merge commit).
	it('Pass 2 — resolves via a stored PR head SHA when the deploy targets the PR branch directly', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'pr-head-bet',
			status: 'active',
			metadata: { branch: 'bet/pr-head', awaiting_deploy: true },
		})
		const prHeadSha = shaOf('d')
		await seedMergedPrEvent(workspaceId, actorId, shaOf('e'), 'bet/pr-head', prHeadSha)

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha: prHeadSha,
			deployedAt: '2026-07-01T12:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.reason).toBe('pass2_pr_head_sha')

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-07-01T12:00:00.000Z')
	})

	// Both passes miss: no metadata mutation, matched=false so the receiver
	// takes the unattributed-log branch.
	it('returns matched=false and mutates no row when both passes miss', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'unrelated',
			status: 'active',
			metadata: { branch: 'bet/other', awaiting_deploy: true },
		})

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha: shaOf('f'),
			deployedAt: '2026-07-01T13:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(false)

		const metadata = await readMetadata(bet.id)
		expect(metadata?.awaiting_deploy).toBe(true)
		expect(metadata?.deployed_at).toBeUndefined()
	})

	// Collision guard: if `deployed_at` is already set (e.g. a redelivery via a
	// distinct X-GitHub-Delivery UUID), the existing timestamp is preserved.
	it('does not overwrite an existing deployed_at (collision guard)', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			title: 'already-deployed',
			status: 'active',
			metadata: {
				branch: 'bet/already',
				awaiting_deploy: false,
				deployed_at: '2026-06-30T08:00:00.000Z',
			},
		})
		const sha = shaOf('g')
		await seedPushEvent(workspaceId, actorId, sha, 'refs/heads/bet/already')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T14:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.collision).toBe(true)

		const metadata = await readMetadata(bet.id)
		expect(metadata?.deployed_at).toBe('2026-06-30T08:00:00.000Z')
	})

	// Task-level: a matched `task` row gets `last_deployed_at` instead of
	// `deployed_at`, and `awaiting_deploy` is not touched (bets own that flag).
	it('writes last_deployed_at on a matched task without touching awaiting_deploy', async () => {
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'task-under-bet',
			status: 'in_progress',
			metadata: { branch: 'task/foo' },
		})
		const sha = shaOf('h')
		await seedPushEvent(workspaceId, actorId, sha, 'refs/heads/task/foo')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T15:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(true)
		expect(result.objectType).toBe('task')

		const metadata = await readMetadata(task.id)
		expect(metadata?.last_deployed_at).toBe('2026-07-01T15:00:00.000Z')
		expect(metadata?.deployed_at).toBeUndefined()
		expect(metadata?.awaiting_deploy).toBeUndefined()
	})

	// Concurrency: 10 distinct-SHA deployments arriving in parallel must each
	// attribute to their own bet with no deadlocks and no cross-contamination.
	// Row-level locking prevents collisions because each transaction locks a
	// different `objects.id`.
	it('handles 10 concurrent distinct-SHA deployments without deadlock or cross-attribution', async () => {
		const seeded: Array<{ betId: string; sha: string; deployedAt: string }> = []
		for (let i = 0; i < 10; i++) {
			const branch = `bet/parallel-${i}`
			const bet = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				title: `parallel-${i}`,
				status: 'active',
				metadata: { branch, awaiting_deploy: true },
			})
			const sha = shaOf(`p${i}`)
			await seedPushEvent(workspaceId, actorId, sha, `refs/heads/${branch}`)
			const deployedAt = `2026-07-01T16:00:${String(i).padStart(2, '0')}.000Z`
			seeded.push({ betId: bet.id, sha, deployedAt })
		}

		const results = await Promise.all(
			seeded.map(({ sha, deployedAt }) =>
				attributeDeploymentToObject({
					db,
					workspaceId,
					sha,
					deployedAt,
					deploymentRef: 'refs/heads/main',
				}),
			),
		)

		expect(results.every((r) => r.matched)).toBe(true)
		const attributedIds = new Set(results.map((r) => r.objectId))
		expect(attributedIds.size).toBe(10)

		for (const { betId, deployedAt } of seeded) {
			const metadata = await readMetadata(betId)
			expect(metadata?.deployed_at).toBe(deployedAt)
			expect(metadata?.awaiting_deploy).toBe(false)
		}
	})

	// Workspace scoping: an event and a bet with a matching branch in a
	// different workspace must not attribute across workspaces.
	it('does not cross workspace boundaries', async () => {
		const otherWs = await insertWorkspace(db, actorId)
		const otherBet = await insertObject(db, otherWs.id, actorId, {
			type: 'bet',
			title: 'other-ws-bet',
			status: 'active',
			metadata: { branch: 'bet/shared-name', awaiting_deploy: true },
		})
		const sha = shaOf('i')
		await seedPushEvent(otherWs.id, actorId, sha, 'refs/heads/bet/shared-name')

		const result = await attributeDeploymentToObject({
			db,
			workspaceId,
			sha,
			deployedAt: '2026-07-01T17:00:00.000Z',
			deploymentRef: 'refs/heads/main',
		})

		expect(result.matched).toBe(false)

		const metadata = await readMetadata(otherBet.id)
		expect(metadata?.awaiting_deploy).toBe(true)
		expect(metadata?.deployed_at).toBeUndefined()
	})
})
