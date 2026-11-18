import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events, actors, forYouWithdrawals, objects, workspaceMembers } from '@maskin/db/schema'
import { type CommentDecision, PILOT_REFUSAL } from '@maskin/shared'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { capturePosthogEvent } from './analytics/posthog'
import { postComment } from './comments'
import { recordEventReturning } from './events/record-event'
import { logger } from './logger'
import { PILOT_FLOW_STATUSES, flowsOfSession } from './session-flow'

/**
 * Pilot holds the steps that leave the company or cannot be undone (the list is in
 * packages/shared/src/pilot-hold.ts). A session under a flow in pilot that calls one is refused,
 * a card goes to a person, and after they approve that exact call the agent repeats it and it
 * goes through once.
 *
 * Three events carry the whole state, so there is no new table:
 *   flow_gate_refused   the agent was refused. Holds the card it got (once per call, see below).
 *   flow_call_answered  a person's answer on that card (written by the reply, routes/events.ts).
 *   flow_approval_used  the approval was spent by the repeated call.
 * They carry the tool name and a hash of the arguments, never the arguments.
 *
 * Limit, said plainly: this is a tool-level guardrail, not a sandbox. An agent that drops the
 * session header or calls an outside service from the container shell is not stopped here.
 */

export const FLOW_GATE_REFUSED_ACTION = 'flow_gate_refused'
export const FLOW_CALL_ANSWERED_ACTION = 'flow_call_answered'
export const FLOW_APPROVAL_USED_ACTION = 'flow_approval_used'

/** How long a card and a person's yes stay good. The agent is woken by the reply. */
export const FLOW_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

export const APPROVE_LABEL = 'Approve'
export const REJECT_LABEL = 'Reject'

export type PilotHoldResult = { held: false } | { held: true; message: string }

export interface PilotHoldInput {
	workspaceId: string
	agentId: string
	/** From X-Maskin-Session-Id. A call with none (a person chatting with the agent) is not held. */
	sessionId?: string | null
	/** The tool as the agent calls it. */
	tool: string
	args: unknown
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, stable(v)]),
		)
	}
	return value
}

/** The same tool with the same arguments hashes the same, whatever the key order. */
export function callHash(tool: string, args: unknown): string {
	return createHash('sha256')
		.update(`${tool}\n${JSON.stringify(stable(args ?? {}))}`)
		.digest('hex')
}

export function waitingMessage(): string {
	return `${PILOT_REFUSAL}. A card is waiting for a person to approve this exact call. Nothing was done. End your turn: you are woken after they answer, then repeat the same call and it goes through once.`
}

export function rejectedMessage(): string {
	return `${PILOT_REFUSAL}, and a person rejected this exact call. Nothing was done. Do not retry it or look for another way to do it.`
}

function cannotCheckMessage(): string {
	return `${PILOT_REFUSAL}. This flow could not be checked just now, so the call was held. Nothing was done. Try again shortly.`
}

/** Builds the card. Plain words, one clause per line, nothing a person has to decode. */
export function buildGateCard(input: {
	agentName: string
	flowTitle: string
	tool: string
}): { content: string; decision: CommentDecision } {
	const step = input.tool.replace(/_/g, ' ')
	return {
		content: `${PILOT_REFUSAL}. Held: ${step}. After a person answers, repeat the same call.`,
		decision: {
			title: 'Allow this step in pilot?',
			summary: `${input.agentName} wants to run "${step}" in ${input.flowTitle}. The flow is in pilot, so it waits for a person.`,
			options: [
				{
					label: APPROVE_LABEL,
					destructive: true,
					consequences: ['The agent repeats the call once', 'It goes out exactly as asked'],
				},
				{
					label: REJECT_LABEL,
					recommended: true,
					consequences: ['Nothing goes out', 'The agent is told it was rejected'],
				},
			],
		},
	}
}

async function capture(
	event: string,
	input: PilotHoldInput,
	props: Record<string, string | number | boolean>,
): Promise<void> {
	try {
		// Names, counts and categories only. Never the arguments, never the hash.
		await capturePosthogEvent(event, input.agentId, {
			workspace_id: input.workspaceId,
			agent_id: input.agentId,
			tool: input.tool,
			...props,
		})
	} catch (err) {
		logger.warn('Could not capture a pilot hold event', { event, error: String(err) })
	}
}

/** The oldest unspent approval of exactly this call, spent now. Null when there is none. */
async function spendApproval(
	db: Database,
	input: PilotHoldInput,
	hash: string,
	flowId: string,
): Promise<boolean> {
	const since = new Date(Date.now() - FLOW_APPROVAL_TTL_MS)
	const approvals = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.action, FLOW_CALL_ANSWERED_ACTION),
				gt(events.createdAt, since),
				sql`${events.data}->>'answer' = 'approve'`,
				sql`${events.data}->>'hash' = ${hash}`,
				sql`${events.data}->>'requested_by' = ${input.agentId}`,
			),
		)
		.orderBy(asc(events.id))
		.limit(20)
	for (const approval of approvals) {
		const spent = await db.transaction(async (tx) => {
			// Two calls at once cannot both spend one approval.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`flow-approval:${approval.id}`}))`,
			)
			const [used] = await tx
				.select({ id: events.id })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, input.workspaceId),
						eq(events.action, FLOW_APPROVAL_USED_ACTION),
						sql`${events.data}->>'answered_event_id' = ${String(approval.id)}`,
					),
				)
				.limit(1)
			if (used) return false
			await recordEventReturning(tx, {
				workspaceId: input.workspaceId,
				actorId: input.agentId,
				action: FLOW_APPROVAL_USED_ACTION,
				entityType: 'object',
				entityId: flowId,
				data: { tool: input.tool, hash, answered_event_id: String(approval.id) },
			})
			return true
		})
		if (spent) return true
	}
	return false
}

type CardState = 'none' | 'waiting' | 'rejected'

/** What became of the latest card for this exact call: waiting, rejected, or none to speak of. */
async function cardState(db: Database, input: PilotHoldInput, hash: string): Promise<CardState> {
	const since = new Date(Date.now() - FLOW_APPROVAL_TTL_MS)
	const [refused] = await db
		.select({ cardEventId: sql<string | null>`${events.data}->>'card_event_id'` })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.actorId, input.agentId),
				eq(events.action, FLOW_GATE_REFUSED_ACTION),
				gt(events.createdAt, since),
				sql`${events.data}->>'hash' = ${hash}`,
				sql`${events.data}->>'card_event_id' is not null`,
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	if (!refused?.cardEventId) return 'none'

	const [answered] = await db
		.select({ answer: sql<string>`${events.data}->>'answer'` })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.action, FLOW_CALL_ANSWERED_ACTION),
				sql`${events.data}->>'card_event_id' = ${refused.cardEventId}`,
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	if (answered) return answered.answer === 'reject' ? 'rejected' : 'none'

	// A card the agent's later card replaced is no longer on anyone's For You: post a new one.
	const [withdrawn] = await db
		.select({ id: forYouWithdrawals.sourceCommentId })
		.from(forYouWithdrawals)
		.where(eq(forYouWithdrawals.sourceCommentId, Number(refused.cardEventId)))
		.limit(1)
	return withdrawn ? 'none' : 'waiting'
}

/** The person the card goes to: the flow's driver when a person, else the workspace owner. */
async function cardRecipient(
	db: Database,
	workspaceId: string,
	flow: { driver: string | null },
): Promise<string[]> {
	if (flow.driver) {
		const [driver] = await db
			.select({ type: actors.type })
			.from(actors)
			.where(eq(actors.id, flow.driver))
			.limit(1)
		if (driver && driver.type !== 'agent') return [flow.driver]
	}
	const [owner] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
		.orderBy(asc(workspaceMembers.joinedAt))
		.limit(1)
	return owner ? [owner.actorId] : []
}

/**
 * Decides one call. Held means the caller refuses it with `message` and does nothing; not held
 * means it runs. Reads are never asked about: the caller only asks for a tool that is on the
 * outbound list. Read on every call, never cached, so moving a flow out of pilot applies at once.
 */
export async function checkPilotHold(
	db: Database,
	input: PilotHoldInput,
): Promise<PilotHoldResult> {
	if (!input.sessionId) return { held: false }
	let pilotFlows: Array<{ id: string; status: string }>
	try {
		const flows = await flowsOfSession(db, {
			workspaceId: input.workspaceId,
			agentId: input.agentId,
			sessionId: input.sessionId,
		})
		pilotFlows = flows
			.filter((flow) => PILOT_FLOW_STATUSES.includes(flow.status))
			.sort((a, b) => a.id.localeCompare(b.id))
	} catch (err) {
		logger.error('Could not read the flow of a session, holding the call', {
			workspaceId: input.workspaceId,
			tool: input.tool,
			error: err instanceof Error ? err.message : String(err),
		})
		return { held: true, message: cannotCheckMessage() }
	}
	const flow = pilotFlows[0]
	if (!flow) return { held: false }

	try {
		const hash = callHash(input.tool, input.args)
		if (await spendApproval(db, input, hash, flow.id)) {
			await capture('flow_approval_used', input, { step: 'pilot' })
			return { held: false }
		}

		const refuse = async (state: CardState | 'new', cardEventId?: number) => {
			await recordEventReturning(db, {
				workspaceId: input.workspaceId,
				actorId: input.agentId,
				action: FLOW_GATE_REFUSED_ACTION,
				entityType: 'object',
				entityId: flow.id,
				data: {
					tool: input.tool,
					kind: 'needs_approval',
					step: 'pilot',
					hash,
					...(cardEventId ? { card_event_id: String(cardEventId) } : {}),
				},
			})
			await capture('flow_gate_refused', input, {
				step: 'pilot',
				kind: 'needs_approval',
				new_card: state === 'new',
			})
			return {
				held: true as const,
				message: state === 'rejected' ? rejectedMessage() : waitingMessage(),
			}
		}

		// One card per call: two identical calls at once must not each post one.
		return await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`flow-gate:${input.agentId}:${hash}`}))`,
			)
			const txDb = tx as unknown as Database
			const state = await cardState(txDb, input, hash)
			if (state !== 'none') return refuse(state)

			const [agent] = await txDb
				.select({ name: actors.name })
				.from(actors)
				.where(eq(actors.id, input.agentId))
				.limit(1)
			const [flowRow] = await txDb
				.select({ title: objects.title, driver: objects.driver })
				.from(objects)
				.where(eq(objects.id, flow.id))
				.limit(1)
			const card = buildGateCard({
				agentName: agent?.name ?? 'An agent',
				flowTitle: flowRow?.title ?? 'this flow',
				tool: input.tool,
			})
			const posted = await postComment(txDb, {
				workspaceId: input.workspaceId,
				actorId: input.agentId,
				entityId: flow.id,
				content: card.content,
				mentions: await cardRecipient(txDb, input.workspaceId, { driver: flowRow?.driver ?? null }),
				decision: card.decision,
				attention: 3,
				authorSessionId: input.sessionId ?? undefined,
			})
			return refuse('new', Number(posted.comment.id))
		})
	} catch (err) {
		// Not being able to ask must never let a covered call through.
		logger.error('Pilot hold failed, holding the call', {
			workspaceId: input.workspaceId,
			tool: input.tool,
			error: err instanceof Error ? err.message : String(err),
		})
		return { held: true, message: cannotCheckMessage() }
	}
}

/** The decision a person's reply on a gate card makes, from the reply text. */
export function answerOf(content: string): 'approve' | 'reject' | null {
	const text = content.trim()
	if (text === APPROVE_LABEL) return 'approve'
	if (text === REJECT_LABEL) return 'reject'
	return null
}

export interface FlowCallTap {
	cardEventId: number
	flowId: string
	hash: string
	tool: string
	requestedBy: string
	answer: 'approve' | 'reject'
}

/**
 * The answer a person's reply gives to a gate card, if the reply is on one. A card counts only
 * when Maskin itself recorded refusing a call with it (a flow_gate_refused event that names the
 * card), so a decision card an agent writes by hand never approves anything.
 */
export async function resolveFlowCallTap(
	db: Database,
	params: {
		workspaceId: string
		entityId: string
		parentEventId: number | undefined
		content: string
	},
): Promise<FlowCallTap | null> {
	if (params.parentEventId === undefined) return null
	const answer = answerOf(params.content)
	if (!answer) return null
	const [refused] = await db
		.select({ actorId: events.actorId, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, params.workspaceId),
				eq(events.action, FLOW_GATE_REFUSED_ACTION),
				eq(events.entityId, params.entityId),
				sql`${events.data}->>'card_event_id' = ${String(params.parentEventId)}`,
			),
		)
		.limit(1)
	const data = refused?.data as { hash?: string; tool?: string } | null | undefined
	if (!refused || !data?.hash || !data.tool) return null
	return {
		cardEventId: params.parentEventId,
		flowId: params.entityId,
		hash: data.hash,
		tool: data.tool,
		requestedBy: refused.actorId,
		answer,
	}
}

/** Records a person's answer, in the same transaction as their reply. */
export async function recordFlowCallAnswer(
	tx: Parameters<typeof recordEventReturning>[0],
	params: { workspaceId: string; approverId: string; tap: FlowCallTap },
) {
	const { tap } = params
	return recordEventReturning(tx, {
		workspaceId: params.workspaceId,
		actorId: params.approverId,
		action: FLOW_CALL_ANSWERED_ACTION,
		entityType: 'object',
		entityId: tap.flowId,
		data: {
			answer: tap.answer,
			card_event_id: String(tap.cardEventId),
			hash: tap.hash,
			tool: tap.tool,
			requested_by: tap.requestedBy,
		},
	})
}
