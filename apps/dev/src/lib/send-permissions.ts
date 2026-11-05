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
