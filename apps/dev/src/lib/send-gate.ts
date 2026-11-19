import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { SendPermissionMode } from '@maskin/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { recordEventReturning } from './events/record-event'
import { logger } from './logger'
import { AUTO_SENT_ACTION } from './object-delivery'
import { resolveSendMode } from './send-permissions'
import { PILOT_FLOW_STATUSES, flowsOfSession } from './session-flow'

/**
 * What a send tool does with a call, once the integration level has let it through (Read and
 * No access never reach here; the access gate refuses them first):
 *
 *   send_now        Read & write with the kind set to always_allow: the agent's call goes out
 *                   as given, with no draft, card or wait
 *   needs_approval  the kind is set to ask_first: nothing goes out until a person approved the
 *                   exact text of a draft (card, edit then approve, or a yes in the chat)
 *   denied          the kind is set to deny: nothing goes out, whatever the agent says
 *
 * The setting is per agent and per draft kind, read now on every call (see send-permissions.ts).
 * Inside a flow in pilot, Always allow counts as ask_first (deny stays deny).
 * A caller with no database handle cannot be resolved and is treated as ask_first, so a
 * missing handle never widens what sends.
 */
export type SendDecision = 'send_now' | 'needs_approval' | 'denied'

const DECISIONS: Record<SendPermissionMode, SendDecision> = {
	always_allow: 'send_now',
	ask_first: 'needs_approval',
	deny: 'denied',
}

export async function decideSend(
	db: Database | undefined,
	params: { workspaceId: string; agentId: string; kind: string; sessionId?: string | null },
): Promise<SendDecision> {
	if (!db) return 'needs_approval'
	const { mode } = await resolveSendMode(db, params)
	const decision = DECISIONS[mode]
	if (decision !== 'send_now' || !params.sessionId) return decision
	return (await heldByPilotFlow(db, { ...params, sessionId: params.sessionId }))
		? 'needs_approval'
		: 'send_now'
}

/**
 * True when the calling session runs under a flow in pilot, so a send set to Always allow waits
 * for a person like Ask first. Read now on every call, never cached: moving a flow out of pilot
 * changes the very next send. Deny and Ask first are not asked here, they already hold. When
 * several flows qualify, one in pilot is enough. A call with no session (a person chatting with
 * the agent) is not held, a person is already in that conversation. A lookup that fails holds
 * the send, like a missing database handle.
 */
async function heldByPilotFlow(
	db: Database,
	params: { workspaceId: string; agentId: string; sessionId: string },
): Promise<boolean> {
	try {
		const flows = await flowsOfSession(db, params)
		return flows.some((flow) => PILOT_FLOW_STATUSES.includes(flow.status))
	} catch (err) {
		logger.error('Could not read the flow of a session, holding the send', {
			workspaceId: params.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return true
	}
}

/** The refusal for a send the person set to deny. Same wording for every provider. */
export function deniedMessage(what: string): string {
	return `Sending ${what} is turned off for this agent in the workspace's send settings. Nothing was sent. Do not retry or look for another way to send it; ask a person to change the setting if it should be on.`
}

/**
 * Appended to an ask-first refusal. Tells the agent the whole path in one go, including that a
 * person's yes in the chat counts the same as a tap on the card.
 */
export const ASK_FIRST_STEPS =
	'This agent is set to ask first for this kind of send. Save the exact text as a task or object with the right metadata.kind, link it in the chat or put it on a decision card, and ask the person. They can edit the text on the card before approving, or just say yes in the chat (then call approve_draft_from_chat). Once it is approved, call this tool again with only object_id. Nothing was sent.'

/**
 * Logs on the draft that an agent sent it without approval, because its setting is Always allow.
 * Call it where an object send is released with no approval to claim. One event per draft text
 * and agent: the kind, the content hash and the setting that allowed it. A retry after a send
 * that failed in an unclear way finds the event already there and writes nothing, and two calls
 * at once cannot each write one (an advisory lock on the draft and text). Never throws: the
 * record is a log, and a failure to write it must not stop or change the send.
 *
 * The card reads it only once a `delivered` event for the same text follows (see
 * `withDeliveryState`), so a send that was released and then failed shows no "sent" line.
 */
export async function recordAutoSent(
	db: Database,
	params: {
		workspaceId: string
		agentId: string
		object: { id: string; type: string }
		kind: string
		contentHash: string
	},
): Promise<void> {
	const { workspaceId, agentId, object, kind, contentHash } = params
	try {
		const setting = await resolveSendMode(db, { workspaceId, agentId, kind })
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`auto-sent:${object.id}:${contentHash}`}))`,
			)
			const [existing] = await tx
				.select({ id: events.id })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityId, object.id),
						eq(events.action, AUTO_SENT_ACTION),
						eq(events.actorId, agentId),
						sql`${events.data}->>'content_hash' = ${contentHash}`,
					),
				)
				.orderBy(desc(events.id))
				.limit(1)
			if (existing) return
			await recordEventReturning(tx, {
				workspaceId,
				actorId: agentId,
				action: AUTO_SENT_ACTION,
				entityType: object.type,
				entityId: object.id,
				data: {
					kind,
					content_hash: contentHash,
					setting: { mode: setting.mode, source: setting.source, setting_id: setting.settingId },
				},
			})
		})
	} catch (err) {
		logger.error('Could not record that a draft was sent without approval', {
			workspaceId,
			objectId: object.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
