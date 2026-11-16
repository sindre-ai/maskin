/**
 * decision-default-wake.ts — carries out the default on silence of a decision card (bet "Agents
 * take the lead", task "Let decision cards carry a default on silence"). No model call.
 *
 * A card can name one option as its default (`default_on_silence`) and a deadline (`expires_at`).
 * When the deadline passes and no person has replied to the card, the agent that posted it is woken
 * once, with the default named, so it carries on instead of waiting. The shared schema only lets a
 * card carry a default when it cannot send, spend or delete (see comment-decision.ts), so the
 * default is always a step the agent could have taken without asking.
 *
 * Every 5 minutes, on every server instance, for each workspace with the `decision-default` flag:
 *   - the card's deadline passed within the last hour (a card that ran out earlier, such as while
 *     the server was down, is left alone: a stale default is worse than none);
 *   - nobody but the asking agent replied in the card's thread, and the card was not withdrawn;
 *   - the object the card is on is still open and the agent is not paused by a person.
 *
 * Once only. Inserting the card's row in for_you_withdrawals is the claim: its key is the card, so
 * one instance wins and a later tick finds it taken. The card is already hidden at its deadline, so
 * the row changes nothing a person sees. A wake that could not be started is released so the next
 * tick tries again; one the daily budget or cap refused stays claimed and is logged.
 *
 * The wake goes through startSession(), so the cap, the back-off and the daily budget in
 * self-start-limits.ts apply (start_reason `driver_wake`). DriverWaker leaves these cards alone
 * (see scanExpiredDecisions), so the agent is woken once, not twice.
 */
import type { Database } from '@maskin/db'
import { events, actors, forYouWithdrawals, objects } from '@maskin/db/schema'
import {
	type CommentDecision,
	TERMINAL_STATUSES_BY_TYPE,
	findDefaultOnSilenceOption,
	parseCommentDecision,
} from '@maskin/shared'
import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm'
import { isActorHumanPaused } from '../lib/agent-pause'
import { FLAGS, getFeatureFlagConfig } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { SessionNotAdmittedError } from './self-start-limits'
import { startSession } from './session-lifecycle'

export const DEFAULT_SCAN_INTERVAL_MS = 5 * 60_000
/** A card whose deadline passed longer ago than this is not acted on. */
export const DEFAULT_MAX_LATE_MS = 60 * 60_000
/** A card older than this is not looked at. Cards expire within days. */
const CARD_MAX_AGE_MS = 14 * 24 * 60 * 60_000
const CARDS_PER_TICK = 200
const CLAIM_REASON = 'Deadline passed with no answer, default carried out by the asking agent'

/** What the agent is told. Names the default and what the person was shown it would mean. */
export function buildDefaultPrompt(input: {
	object: { id: string; type: string; title: string | null; status: string }
	decision: Pick<CommentDecision, 'title' | 'expires_at' | 'options'>
}): string {
	const chosen = findDefaultOnSilenceOption(input.decision)
	const lines = [
		'A decision card you posted ran out with no answer. No person asked for this run.',
		'',
		`Object: ${input.object.title ?? '(untitled)'} (${input.object.type}, ${input.object.status})`,
		`Object ID: ${input.object.id}`,
		`Card: ${input.decision.title}`,
		`Deadline: ${input.decision.expires_at}`,
		'',
		`No answer, default is: ${chosen?.label ?? '(none)'}`,
		...(chosen?.consequences ?? []).map((line) => `- ${line}`),
		'',
		'You named this default when you posted the card, and the person saw it on the card. Carry it out now, as a step you can undo. Then comment on the object in a line or two saying what you did, so the person can change course. If the object has changed so the default no longer fits, say so on the object and change nothing.',
	]
	return lines.join('\n')
}

export interface DecisionDefaultWakeOptions {
	intervalMs?: number
	maxLateMs?: number
	now?: () => Date
}

export class DecisionDefaultWake {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private now: () => Date
	private intervalMs: number
	private maxLateMs: number

	constructor(
		private db: Database,
		opts: DecisionDefaultWakeOptions = {},
	) {
		this.intervalMs = opts.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS
		this.maxLateMs = opts.maxLateMs ?? DEFAULT_MAX_LATE_MS
		this.now = opts.now ?? (() => new Date())
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('Decision default wake failed', { error: String(err) }),
			)
		}, this.intervalMs)
		this.timer.unref?.()
		logger.info('Decision default wake started')
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	/** Workspaces whose flag list names the default. The list comes from the environment. */
	private flaggedWorkspaceIds(): string[] {
		const suffix = `:${FLAGS.DECISION_DEFAULT}`
		const ids: string[] = []
		for (const entry of getFeatureFlagConfig().workspaceFeatures) {
			if (entry.endsWith(suffix)) ids.push(entry.slice(0, -suffix.length))
		}
		return ids
	}

	/** One pass. A pass that is still running is not started twice. */
	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const workspaceIds = this.flaggedWorkspaceIds()
			if (workspaceIds.length === 0) return
			const now = this.now()
			const rows = await this.db
				.select({
					id: events.id,
					workspaceId: events.workspaceId,
					actorId: events.actorId,
					entityId: events.entityId,
					data: events.data,
				})
				.from(events)
				.where(
					and(
						inArray(events.workspaceId, workspaceIds),
						eq(events.action, 'commented'),
						eq(events.entityType, 'object'),
						gte(events.createdAt, new Date(now.getTime() - CARD_MAX_AGE_MS)),
						sql`${events.data}->'decision'->'options' @> '[{"default_on_silence": true}]'::jsonb`,
						sql`${events.data}->'decision'->>'expires_at' IS NOT NULL`,
					),
				)
				.limit(CARDS_PER_TICK)
			for (const row of rows) {
				await this.handle({ ...row, id: Number(row.id) }, now).catch((err) =>
					logger.error('Decision default wake failed for a card', {
						card_id: Number(row.id),
						error: String(err),
					}),
				)
			}
		} finally {
			this.running = false
		}
	}

	private async handle(
		card: {
			id: number
			workspaceId: string
			actorId: string
			entityId: string
			data: unknown
		},
		now: Date,
	): Promise<void> {
		const decision = parseCommentDecision((card.data as { decision?: unknown } | null)?.decision)
		if (!decision?.expires_at || !findDefaultOnSilenceOption(decision)) return
		const deadline = new Date(decision.expires_at).getTime()
		if (deadline > now.getTime() || deadline <= now.getTime() - this.maxLateMs) return

		const [agent] = await this.db
			.select({ id: actors.id })
			.from(actors)
			.where(and(eq(actors.id, card.actorId), eq(actors.type, 'agent')))
			.limit(1)
		if (!agent) return
		const [object] = await this.db
			.select({
				id: objects.id,
				type: objects.type,
				title: objects.title,
				status: objects.status,
			})
			.from(objects)
			.where(and(eq(objects.id, card.entityId), eq(objects.workspaceId, card.workspaceId)))
			.limit(1)
		if (!object || (TERMINAL_STATUSES_BY_TYPE[object.type] ?? []).includes(object.status)) return
		if (await this.isAnswered(card)) return
		if (await isActorHumanPaused(this.db, card.actorId)) return

		const [claim] = await this.db
			.insert(forYouWithdrawals)
			.values({
				sourceCommentId: card.id,
				workspaceId: card.workspaceId,
				withdrawnBy: card.actorId,
				reason: CLAIM_REASON,
			})
			.onConflictDoNothing()
			.returning({ id: forYouWithdrawals.sourceCommentId })
		// Withdrawn already (by the agent, a newer card, or an earlier tick or instance).
		if (!claim) return

		try {
			await startSession({
				workspaceId: card.workspaceId,
				actorId: card.actorId,
				callerKind: 'internal',
				actionPrompt: buildDefaultPrompt({ object, decision }),
				config: { start_reason: 'driver_wake', decision_default: { card_id: card.id } },
				createdBy: card.actorId,
				initiatedFromObjectId: object.id,
			})
		} catch (err) {
			if (err instanceof SessionNotAdmittedError) {
				logger.warn('Decision default not carried out: the agent was not admitted', {
					card_id: card.id,
					agent_id: card.actorId,
				})
				return
			}
			// Not decided: release the claim so the next tick tries this card again.
			await this.db.delete(forYouWithdrawals).where(eq(forYouWithdrawals.sourceCommentId, card.id))
			throw err
		}
	}

	/** A reply in the card's thread by a person. An option tap is such a reply. */
	private async isAnswered(card: {
		id: number
		workspaceId: string
		actorId: string
		entityId: string
		data: unknown
	}): Promise<boolean> {
		const parent = Number((card.data as { parentEventId?: unknown } | null)?.parentEventId)
		const root = Number.isFinite(parent) && parent > 0 ? parent : card.id
		const [reply] = await this.db
			.select({ id: events.id })
			.from(events)
			.innerJoin(actors, eq(actors.id, events.actorId))
			.where(
				and(
					eq(events.workspaceId, card.workspaceId),
					eq(events.entityId, card.entityId),
					eq(events.action, 'commented'),
					gt(events.id, card.id),
					eq(actors.type, 'human'),
					sql`${events.data}->>'parentEventId' = ${String(root)}`,
				),
			)
			.limit(1)
		return !!reply
	}
}
