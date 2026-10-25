import { createHash } from 'node:crypto'
import type { Database, Transaction } from '@maskin/db'
import { actors, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { setTriggerMetadataKey } from '../lib/trigger-metadata'

/**
 * Every agent gets one cron trigger named Heartbeat: once a day it checks that
 * what the agent drives is moving and that no person is waiting on it. The
 * trigger carries `metadata.default_heartbeat` so this service can tell it apart
 * from a hand-made trigger that happens to share the name.
 */
export const HEARTBEAT_TRIGGER_NAME = 'Heartbeat'
export const HEARTBEAT_METADATA_KEY = 'default_heartbeat'

/** The prompt every default Heartbeat runs. Reword it here and re-run the backfill to roll it out. */
export const HEARTBEAT_PROMPT = `Heartbeat. Once a day, check that what you own is moving and that no person is waiting on you.

1. What you drive. List every object and loop where you are the driver. Skip anything already finished.
2. Your work. For each one, read where it stands now (status, latest comments, linked objects). If you can move it forward right now, do it in this run. If it is waiting on someone, ask them again only when that is needed to move it forward, with one concrete question: the agent who would know first, then the C-level owner.
3. Your chats. Use list_chats to find chats you are in with people that had activity in the last 25 hours. For each, read the latest messages. Follow up if: a person asked something you never answered; you promised something and have not done it; you said you would check back and have not; or their last message was a problem you only half fixed. Reply in that chat with the result, not a plan.
4. Done means nothing you drive is stalled. For everything you drive, either fix it now or have a good reason why you cannot fix it now (put that reason on the object if it is not already there). Nothing should be waiting on you.`

/** Heartbeats fire between 01:00 and 03:59 UTC, one minute per agent, so they do not all start at once. */
const HEARTBEAT_FIRST_HOUR_UTC = 1
const HEARTBEAT_WINDOW_MINUTES = 180

/** Daily cron expression (UTC) for an agent, spread across the window by its id. */
export function heartbeatCronExpression(actorId: string): string {
	const seed = Number.parseInt(actorId.replaceAll('-', '').slice(0, 8), 16)
	const slot = seed % HEARTBEAT_WINDOW_MINUTES
	const hour = HEARTBEAT_FIRST_HOUR_UTC + Math.floor(slot / 60)
	return `${slot % 60} ${hour} * * *`
}

function promptSha(prompt: string): string {
	return createHash('sha256').update(prompt).digest('hex')
}

/** Retired agents keep their row but must not wake up; they are marked in the description. */
export function isRetiredAgent(description: string | null | undefined): boolean {
	return typeof description === 'string' && description.startsWith('RETIRED')
}

type Writer = Database | Transaction

/**
 * Create the default Heartbeat for a newly created agent. Call it in the same
 * transaction as the workspace_members insert when there is one. Does not look
 * for an existing Heartbeat: a new agent has none, and the create paths must not
 * pay an extra read. Re-runnable creation is `backfillDefaultHeartbeats`.
 */
export async function addDefaultHeartbeat(
	writer: Writer,
	params: { workspaceId: string; actorId: string },
): Promise<string> {
	const { workspaceId, actorId } = params
	const [row] = await writer
		.insert(triggers)
		.values({
			workspaceId,
			name: HEARTBEAT_TRIGGER_NAME,
			type: 'cron',
			config: { expression: heartbeatCronExpression(actorId) },
			actionPrompt: HEARTBEAT_PROMPT,
			targetActorId: actorId,
			enabled: true,
			metadata: { [HEARTBEAT_METADATA_KEY]: { prompt_sha: promptSha(HEARTBEAT_PROMPT) } },
			createdBy: actorId,
		})
		.returning({ id: triggers.id })
	if (!row) throw new Error('Failed to create the default Heartbeat trigger')
	// The trigger runner schedules cron jobs from this event.
	await recordEvent(writer, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'trigger',
		entityId: row.id,
		data: { trigger_name: HEARTBEAT_TRIGGER_NAME, type: 'cron', source: 'default_heartbeat' },
	})
	return row.id
}

export interface HeartbeatBackfillResult {
	/** Agent memberships that should have a Heartbeat. */
	eligible: number
	created: number
	/** Heartbeats whose prompt was brought up to the current wording. */
	reworded: number
}

/** Keeps two concurrent runs from each creating a Heartbeat for the same agent. */
const BACKFILL_LOCK_KEY = 'maskin:backfill-default-heartbeats'

/**
 * Give every existing agent its default Heartbeat, once per workspace it belongs
 * to. Safe to re-run: an agent that has one is left alone, apart from the prompt
 * rollout below.
 *
 * Pass workspaceId to limit the run to one workspace. Without it every workspace in the
 * database is covered, so every agent in every customer workspace starts a daily session.
 *
 * Skipped: humans, integration actors (type 'system' or workspace role 'system')
 * and retired agents.
 *
 * Prompt rollout: when HEARTBEAT_PROMPT changes, a re-run rewrites the prompt of
 * Heartbeats still carrying the wording this service last wrote. One a person has
 * edited is left as they wrote it. Schedule and enabled flag are never touched,
 * so a disabled Heartbeat stays disabled.
 */
export async function backfillDefaultHeartbeats(
	db: Database,
	options: { dryRun?: boolean; workspaceId?: string } = {},
): Promise<HeartbeatBackfillResult> {
	const currentSha = promptSha(HEARTBEAT_PROMPT)

	const run = async (tx: Transaction): Promise<HeartbeatBackfillResult> => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BACKFILL_LOCK_KEY}))`)

		const members = await tx
			.select({
				workspaceId: workspaceMembers.workspaceId,
				actorId: actors.id,
				description: actors.description,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(actors.type, 'agent'),
					ne(workspaceMembers.role, 'system'),
					options.workspaceId ? eq(workspaceMembers.workspaceId, options.workspaceId) : undefined,
				),
			)
		const eligible = members.filter((m) => !isRetiredAgent(m.description))

		const existing = await tx
			.select({
				id: triggers.id,
				workspaceId: triggers.workspaceId,
				targetActorId: triggers.targetActorId,
				actionPrompt: triggers.actionPrompt,
				metadata: triggers.metadata,
			})
			.from(triggers)
			.where(isNotNull(sql`${triggers.metadata} -> ${HEARTBEAT_METADATA_KEY}`))
		const byAgent = new Map(existing.map((t) => [`${t.workspaceId}:${t.targetActorId}`, t]))

		const result: HeartbeatBackfillResult = { eligible: eligible.length, created: 0, reworded: 0 }
		for (const member of eligible) {
			const trigger = byAgent.get(`${member.workspaceId}:${member.actorId}`)
			if (!trigger) {
				result.created++
				if (!options.dryRun) {
					await addDefaultHeartbeat(tx, {
						workspaceId: member.workspaceId,
						actorId: member.actorId,
					})
				}
				continue
			}
			const recorded = (trigger.metadata as Record<string, { prompt_sha?: string }> | null)?.[
				HEARTBEAT_METADATA_KEY
			]?.prompt_sha
			const untouched = recorded === promptSha(trigger.actionPrompt)
			if (!untouched || recorded === currentSha) continue
			result.reworded++
			if (options.dryRun) continue
			await tx
				.update(triggers)
				.set({
					actionPrompt: HEARTBEAT_PROMPT,
					metadata: setTriggerMetadataKey(HEARTBEAT_METADATA_KEY, { prompt_sha: currentSha }),
					updatedAt: new Date(),
				})
				.where(eq(triggers.id, trigger.id))
			await recordEvent(tx, {
				workspaceId: member.workspaceId,
				actorId: member.actorId,
				action: 'updated',
				entityType: 'trigger',
				entityId: trigger.id,
				data: { trigger_name: HEARTBEAT_TRIGGER_NAME, source: 'default_heartbeat' },
			})
		}
		return result
	}

	const result = await db.transaction(run)
	logger.info('Default Heartbeat backfill finished', { ...result, dryRun: options.dryRun === true })
	return result
}
