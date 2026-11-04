import type { Database } from '@maskin/db'
import { sendPermissions } from '@maskin/db/schema'
import { STARTING_SEND_MODES, type SendPermissionMode, isSendPermissionKind } from '@maskin/shared'
import { and, eq, isNull, or } from 'drizzle-orm'

/**
 * Where a send setting came from, most specific first:
 *   agent      a row for this agent and this kind
 *   workspace  the workspace default for this kind
 *   starting   no row at all: the starting table in packages/shared (a kind that is not in the
 *              table is ask_first)
 */
export type SendModeSource = 'agent' | 'workspace' | 'starting'

export interface ResolvedSendMode {
	mode: SendPermissionMode
	source: SendModeSource
	/** The row that decided it, or null when it came from the starting table. */
	settingId: string | null
}

/** The mode in force when nothing is saved for a kind. An unknown kind asks first. */
export function startingSendMode(kind: string): SendPermissionMode {
	return isSendPermissionKind(kind) ? STARTING_SEND_MODES[kind] : 'ask_first'
}

/**
 * The setting that applies to one agent sending one kind of draft, read now. A more specific
 * setting beats a less specific one: the agent's own row, then the workspace default, then the
 * starting table. Nothing is cached, so a change applies to the next send.
 */
export async function resolveSendMode(
	db: Database,
	params: { workspaceId: string; agentId: string; kind: string },
): Promise<ResolvedSendMode> {
	const rows = await db
		.select({
			id: sendPermissions.id,
			agentId: sendPermissions.agentId,
			mode: sendPermissions.mode,
		})
		.from(sendPermissions)
		.where(
			and(
				eq(sendPermissions.workspaceId, params.workspaceId),
				eq(sendPermissions.kind, params.kind),
				or(eq(sendPermissions.agentId, params.agentId), isNull(sendPermissions.agentId)),
			),
		)
	const own = rows.find((r) => r.agentId === params.agentId)
	if (own) return { mode: own.mode, source: 'agent', settingId: own.id }
	const workspaceDefault = rows.find((r) => r.agentId === null)
	if (workspaceDefault) {
		return { mode: workspaceDefault.mode, source: 'workspace', settingId: workspaceDefault.id }
	}
	return { mode: startingSendMode(params.kind), source: 'starting', settingId: null }
}

/** The record that a send went out on an Always allow setting, with no approval in between. */
export const AUTO_SENT_ACTION = 'auto_sent'

/**
 * What the gate decided for one send.
 *
 *   allowed         go ahead. `approval` is the record the send is keyed on (the idempotency key
 *                   and the one-approval-one-send claim use its id), whether a person approved
 *                   or the setting allowed it. `via` says which.
 *   denied          the setting is Deny. Nothing is sent, whatever else is true of the draft.
 *   needs_approval  the setting is Ask first and no person has approved this exact text.
 */
export type SendAuthorization =
	| { outcome: 'allowed'; approval: ObjectApproval; via: 'approval' | 'auto_sent' }
	| { outcome: 'denied'; message: string }
	| { outcome: 'needs_approval' }

/** What an agent is told when the setting is Deny. One wording for every send tool. */
export function deniedMessage(kind: string): string {
	const label = isSendPermissionKind(kind) ? SEND_PERMISSION_KIND_LABELS[kind] : kind
	return `Not sent. Sending ${label} is turned off for you in this workspace. Do not try again or send it another way. A workspace admin can change it under Send permissions in the settings.`
}

/**
 * The one place a send is allowed or held, for every send tool that takes an `object_id`. It
 * reads the setting now, so a change applies to the next send, and decides in this order:
 *
 *   1. Deny refuses, even for a text a person approved.
 *   2. A person's approval of exactly this text releases the send, under any other setting. An
 *      agent may always ask for approval of its own choice, and the approval is then used.
 *   3. Always allow releases the send and writes an `auto_sent` event on the draft (the kind, the
 *      content hash and the setting that allowed it).
 *   4. Ask first (and anything unknown) holds the send until a person approves.
 *
 * The caller is whoever calls the send tool; nothing the call or the draft says can change the
 * result, because the setting is read from the database and only a human admin or owner can
 * write it.
 */
export async function authorizeSend(
	db: Database,
	params: {
		workspaceId: string
		/** The caller of the send tool. */
		agentId: string
		object: { id: string; type: string }
		preview: { kind: string; content_hash: string }
	},
): Promise<SendAuthorization> {
	const { workspaceId, agentId, object, preview } = params
	const setting = await resolveSendMode(db, { workspaceId, agentId, kind: preview.kind })
	if (setting.mode === 'deny') return { outcome: 'denied', message: deniedMessage(preview.kind) }

	const approval = await findCurrentApproval(db, workspaceId, object.id, preview.content_hash)
	if (approval) return { outcome: 'allowed', approval, via: 'approval' }

	if (setting.mode !== 'always_allow') return { outcome: 'needs_approval' }
	return {
		outcome: 'allowed',
		approval: await recordAutoSent(db, { workspaceId, agentId, object, preview, setting }),
		via: 'auto_sent',
	}
}

/**
 * Writes the `auto_sent` event for this draft text, or returns the one already there. One per
 * (draft, text, agent): a retry after a send that failed in an unclear way finds the same event,
 * so the key the send is claimed under does not change and a retry cannot send twice. Callers
 * with the same text are serialised with an advisory lock, so two at once cannot each write one.
 */
async function recordAutoSent(
	db: Database,
	params: {
		workspaceId: string
		agentId: string
		object: { id: string; type: string }
		preview: { kind: string; content_hash: string }
		setting: ResolvedSendMode
	},
): Promise<ObjectApproval> {
	const { workspaceId, agentId, object, preview, setting } = params
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`auto-sent:${object.id}:${preview.content_hash}`}))`,
		)
		const [existing] = await tx
			.select({ id: events.id, actorId: events.actorId, createdAt: events.createdAt })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, object.id),
					eq(events.action, AUTO_SENT_ACTION),
					eq(events.actorId, agentId),
					sql`${events.data}->>'content_hash' = ${preview.content_hash}`,
				),
			)
			.orderBy(desc(events.id))
			.limit(1)
		if (existing) {
			return { id: Number(existing.id), actorId: existing.actorId, createdAt: existing.createdAt }
		}
		const row = await recordEventReturning(tx, {
			workspaceId,
			actorId: agentId,
			action: AUTO_SENT_ACTION,
			entityType: object.type,
			entityId: object.id,
			data: {
				kind: preview.kind,
				content_hash: preview.content_hash,
				setting: {
					mode: setting.mode,
					source: setting.source,
					setting_id: setting.settingId,
				},
			},
		})
		return { id: Number(row.id), actorId: row.actorId, createdAt: row.createdAt }
	})
}
