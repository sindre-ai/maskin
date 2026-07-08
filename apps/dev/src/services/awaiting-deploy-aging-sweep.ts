import type { Database } from '@maskin/db'
import { events, objects, workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'

const TICK_MS = 24 * 60 * 60 * 1000 // 24h
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7d
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Daily aging sweep for bets that reached `awaiting_deploy = true` but never
 * received a matching production `deployment_status` webhook (T3 clears the
 * flag on a successful attribution). Any bet still `awaiting_deploy` seven
 * days after it went live gets surfaced in one workspace-scoped digest per
 * tick — never as a per-bet notification, per the architecture decision.
 *
 * If the stale bet has a `metadata.branch` that matches a stored
 * `github.pull_request` event whose `merge_commit_sha` is null (umbrella PR
 * never landed on `main`), that PR is named as the blocker instead of a
 * generic missing-deploy note. This closes the silent-stall hole from the
 * agent-count fix (21 days awaiting_deploy, umbrella PR never merged).
 */
export class AwaitingDeployAgingSweep {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private staleThresholdMs: number = STALE_THRESHOLD_MS,
		private tickMs: number = TICK_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.tickMs)
		setTimeout(() => this.tick(), 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(): Promise<DigestSummary[]> {
		if (this.running) return []
		this.running = true
		try {
			return await this.sweep()
		} catch (err) {
			logger.error('Awaiting-deploy aging sweep tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return []
		} finally {
			this.running = false
		}
	}

	private async sweep(): Promise<DigestSummary[]> {
		const now = Date.now()
		const cutoffIso = new Date(now - this.staleThresholdMs).toISOString()

		// ISO 8601 sorts lexically the same as chronologically, so a text
		// comparison on the JSONB-extracted string is safe.
		const staleBets = await this.db
			.select({
				id: objects.id,
				workspaceId: objects.workspaceId,
				title: objects.title,
				metadata: objects.metadata,
			})
			.from(objects)
			.where(
				and(
					eq(objects.type, 'bet'),
					sql`${objects.metadata}->>'awaiting_deploy' = 'true'`,
					sql`${objects.metadata}->>'live_started_at' IS NOT NULL`,
					sql`${objects.metadata}->>'live_started_at' <= ${cutoffIso}`,
				),
			)

		if (staleBets.length === 0) return []

		const byWorkspace = new Map<string, typeof staleBets>()
		for (const bet of staleBets) {
			const list = byWorkspace.get(bet.workspaceId) ?? []
			list.push(bet)
			byWorkspace.set(bet.workspaceId, list)
		}

		const summaries: DigestSummary[] = []
		const frontendUrl = frontendBaseUrl()

		for (const [workspaceId, bets] of byWorkspace) {
			const entries: DigestEntry[] = []
			for (const bet of bets) {
				const metadata = (bet.metadata ?? {}) as Record<string, unknown>
				const liveStartedAt =
					typeof metadata.live_started_at === 'string' ? metadata.live_started_at : null
				const ageDays = liveStartedAt
					? Math.floor((now - new Date(liveStartedAt).getTime()) / DAY_MS)
					: 0
				const branch = typeof metadata.branch === 'string' ? metadata.branch : null
				const blocker = branch ? await this.resolveBlocker(workspaceId, branch) : DEFAULT_BLOCKER
				entries.push({
					betId: bet.id,
					betTitle: bet.title,
					ageDays,
					blocker,
					betUrl: `${frontendUrl}/${workspaceId}/objects/${bet.id}`,
				})
			}

			const digestActorId = await this.pickDigestActor(workspaceId)
			if (!digestActorId) {
				logger.warn('Skipping awaiting-deploy digest — no actor to attribute to', {
					workspaceId,
					entryCount: entries.length,
				})
				continue
			}

			const content = renderDigest(entries)
			const [inserted] = await this.db
				.insert(events)
				.values({
					workspaceId,
					actorId: digestActorId,
					action: 'deploy_digest_posted',
					entityType: 'workspace',
					entityId: workspaceId,
					data: {
						content,
						entries: entries.map((e) => ({
							bet_id: e.betId,
							bet_title: e.betTitle,
							age_days: e.ageDays,
							blocker: e.blocker,
							bet_url: e.betUrl,
						})),
					},
				})
				.returning({ id: events.id })

			if (inserted) {
				summaries.push({
					workspaceId,
					entryCount: entries.length,
					eventId: inserted.id,
				})
				logger.info('Awaiting-deploy digest posted', {
					workspaceId,
					entryCount: entries.length,
					eventId: inserted.id,
				})
			}
		}

		return summaries
	}

	/**
	 * Look up the most recent `github.pull_request` event for the bet's branch
	 * targeting `main`. If it exists and `merge_commit_sha` is null / empty,
	 * the umbrella PR never landed — name it as the blocker so a human can go
	 * unblock the merge. Otherwise the merge succeeded but no production
	 * `deployment_status` webhook has landed, so the blocker is generic.
	 */
	private async resolveBlocker(workspaceId: string, branch: string): Promise<string> {
		const [row] = await this.db
			.select({ data: events.data })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, 'github.pull_request'),
					sql`${events.data}->>'pr_head_ref' = ${branch}`,
					sql`${events.data}->>'pr_base_branch' = 'main'`,
				),
			)
			.orderBy(desc(events.id))
			.limit(1)

		if (!row) return DEFAULT_BLOCKER

		const data = (row.data ?? {}) as Record<string, unknown>
		const mergeSha = data.merge_commit_sha
		const hasMerge = typeof mergeSha === 'string' && mergeSha.length > 0
		if (hasMerge) return DEFAULT_BLOCKER

		const prUrl = typeof data.pr_url === 'string' ? data.pr_url : null
		const prNumber = typeof data.pr_number === 'number' ? data.pr_number : null
		if (prUrl && prNumber !== null) return `umbrella [PR #${prNumber}](${prUrl}) not merged to main`
		if (prUrl) return `umbrella [PR](${prUrl}) not merged to main`
		if (prNumber !== null) return `umbrella PR #${prNumber} not merged to main`
		return 'umbrella PR not merged to main'
	}

	private async pickDigestActor(workspaceId: string): Promise<string | null> {
		const [ws] = await this.db
			.select({ createdBy: workspaces.createdBy })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)
		if (ws?.createdBy) return ws.createdBy

		const [member] = await this.db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, workspaceId))
			.limit(1)
		return member?.actorId ?? null
	}
}

export interface DigestEntry {
	betId: string
	betTitle: string | null
	ageDays: number
	blocker: string
	betUrl: string
}

export interface DigestSummary {
	workspaceId: string
	entryCount: number
	eventId: number
}

const DEFAULT_BLOCKER = 'no production deployment_status event received yet'

function renderDigest(entries: DigestEntry[]): string {
	const heading = `Unconfirmed-deploy digest — ${entries.length} bet${
		entries.length === 1 ? '' : 's'
	} awaiting production deploy for 7+ days`
	const lines = entries.map((e) => {
		const title = e.betTitle ?? e.betId
		const daysLabel = `${e.ageDays} day${e.ageDays === 1 ? '' : 's'}`
		return `- [${title}](${e.betUrl}) — ${daysLabel} awaiting deploy — blocker: ${e.blocker}`
	})
	return `${heading}\n\n${lines.join('\n')}`
}
