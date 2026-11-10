import type { Database } from '@maskin/db'
import { actors, sendPermissions, workspaceMembers } from '@maskin/db/schema'
import {
	SEND_PERMISSION_KINDS,
	STARTING_SEND_MODES,
	type SendPermissionKind,
	type SendPermissionMode,
	isSendPermissionKind,
} from '@maskin/shared'
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

export interface EffectiveSendSetting {
	mode: SendPermissionMode
	source: SendModeSource
}

/**
 * Every send setting in a workspace, resolved the way the send gate resolves it: the workspace
 * default per kind, and for every agent the mode in force per kind with where it came from.
 */
export async function loadSendSettings(
	db: Database,
	workspaceId: string,
): Promise<{
	defaults: Record<SendPermissionKind, EffectiveSendSetting>
	agents: Array<{
		agentId: string
		name: string
		settings: Record<SendPermissionKind, EffectiveSendSetting>
	}>
}> {
	const [rows, agents] = await Promise.all([
		db.select().from(sendPermissions).where(eq(sendPermissions.workspaceId, workspaceId)),
		db
			.select({ id: actors.id, name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))
			.orderBy(actors.name),
	])

	const defaults = {} as Record<SendPermissionKind, EffectiveSendSetting>
	for (const kind of SEND_PERMISSION_KINDS) {
		const row = rows.find((r) => r.agentId === null && r.kind === kind)
		defaults[kind] = row
			? { mode: row.mode, source: 'workspace' }
			: { mode: startingSendMode(kind), source: 'starting' }
	}

	return {
		defaults,
		agents: agents.map((agent) => {
			const settings = {} as Record<SendPermissionKind, EffectiveSendSetting>
			for (const kind of SEND_PERMISSION_KINDS) {
				const own = rows.find((r) => r.agentId === agent.id && r.kind === kind)
				settings[kind] = own ? { mode: own.mode, source: 'agent' } : defaults[kind]
			}
			return { agentId: agent.id, name: agent.name, settings }
		}),
	}
}
