import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/**
 * Shown in place of every env and header value in an actor's tools config when
 * the caller is neither that actor nor a workspace admin. Keys, server names,
 * commands and urls stay visible. Inside args only the secret part of an entry
 * is replaced (for example the token after "Authorization: Bearer ").
 */
export const MASKED_VALUE = '********'

const SECRET_FIELDS = ['env', 'headers'] as const

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A credential written into a command argument. Only the value part is masked,
// so the key, the scheme prefix and the surrounding args stay readable.
const SECRET_KEYWORD =
	'(?:[\\w-]*?)(?:authorization|token|secret|password|passwd|api[-_]?key|apikey)(?![A-Za-z])'
const KEYED_VALUE = new RegExp(
	`(?<![A-Za-z0-9])(${SECRET_KEYWORD}\\s*[:=]\\s*(?:(?:Bearer|Basic|Token)\\s+)?)(?!\\$)([^\\s"'&]+)`,
	'gi',
)
const BEARER_VALUE = /\b(Bearer\s+)(?!\$)([^\s"'&]+)/gi
const URL_PASSWORD = /(:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/g
// A bare flag whose next arg is the value, e.g. ["--api-key", "<value>"].
const SECRET_FLAG = new RegExp(`^--?${SECRET_KEYWORD}$`, 'i')

function maskArg(arg: string): string {
	return arg
		.replace(KEYED_VALUE, `$1${MASKED_VALUE}`)
		.replace(BEARER_VALUE, `$1${MASKED_VALUE}`)
		.replace(URL_PASSWORD, `$1${MASKED_VALUE}`)
}

/**
 * Copy of an args list with the secret part of each entry replaced by MASKED_VALUE.
 * Masking is positional and idempotent: masking an already-masked list changes nothing.
 */
export function maskArgs(args: unknown[]): unknown[] {
	return args.map((arg, index) => {
		if (typeof arg !== 'string') return arg
		const previous = args[index - 1]
		if (
			typeof previous === 'string' &&
			SECRET_FLAG.test(previous) &&
			!arg.startsWith('$') &&
			!arg.startsWith('-')
		) {
			return MASKED_VALUE
		}
		return maskArg(arg)
	})
}

function hasSecretArgs(server: JsonRecord): boolean {
	const args = server.args
	if (!Array.isArray(args)) return false
	return maskArgs(args).some((masked, index) => masked !== args[index])
}

function serversOf(tools: unknown): [string, JsonRecord][] {
	if (!isRecord(tools) || !isRecord(tools.mcpServers)) return []
	return Object.entries(tools.mcpServers).filter((entry): entry is [string, JsonRecord] =>
		isRecord(entry[1]),
	)
}

/** True when the config holds at least one env, header or credential-bearing arg worth masking. */
export function hasSecretFields(tools: unknown): boolean {
	return serversOf(tools).some(
		([, server]) =>
			SECRET_FIELDS.some(
				(field) => isRecord(server[field]) && Object.keys(server[field]).length > 0,
			) || hasSecretArgs(server),
	)
}

/** Copy of the tools config with env and header values, and the secret part of args, masked. */
export function maskActorTools(tools: unknown): unknown {
	if (!hasSecretFields(tools)) return tools
	const config = tools as JsonRecord
	const mcpServers: JsonRecord = {}
	for (const [name, server] of Object.entries(config.mcpServers as JsonRecord)) {
		if (!isRecord(server)) {
			mcpServers[name] = server
			continue
		}
		const masked: JsonRecord = { ...server }
		for (const field of SECRET_FIELDS) {
			const values = server[field]
			if (isRecord(values)) {
				masked[field] = Object.fromEntries(Object.keys(values).map((key) => [key, MASKED_VALUE]))
			}
		}
		if (Array.isArray(server.args)) masked.args = maskArgs(server.args)
		mcpServers[name] = masked
	}
	return { ...config, mcpServers }
}

/** The actor itself and admins/owners of a workspace the actor belongs to see real values. */
export async function canViewActorSecrets(
	db: Database,
	callerId: string,
	targetId: string,
): Promise<boolean> {
	if (callerId === targetId) return true

	const adminOf = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, callerId),
				inArray(workspaceMembers.role, ['owner', 'admin']),
			),
		)
	if (adminOf.length === 0) return false

	const [shared] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, targetId),
				inArray(
					workspaceMembers.workspaceId,
					adminOf.map((row) => row.workspaceId),
				),
			),
		)
		.limit(1)
	return shared !== undefined
}

/** Returns the stored tools config as-is for callers allowed to see it, masked otherwise. */
export async function redactActorToolsForCaller(
	db: Database,
	callerId: string,
	targetId: string,
	tools: unknown,
): Promise<unknown> {
	if (!hasSecretFields(tools)) return tools
	if (await canViewActorSecrets(db, callerId, targetId)) return tools
	return maskActorTools(tools)
}

// Rows saved before the schema defaulted `type` and `args` may lack them, while
// the incoming body is always parsed, so compare the normalised form. Args are
// compared with their secret parts masked, so a config read back masked still
// matches the stored one, while a changed host, command or non-secret arg does not.
export function transportOf(server: JsonRecord): string {
	return JSON.stringify([
		server.type ?? (typeof server.url === 'string' ? 'http' : 'stdio'),
		server.command ?? null,
		server.url ?? null,
		Array.isArray(server.args) ? maskArgs(server.args) : (server.args ?? []),
	])
}

function sameTransport(incoming: JsonRecord, stored: JsonRecord): boolean {
	return transportOf(incoming) === transportOf(stored)
}

/**
 * Write-back for a config that was read masked: every MASKED_VALUE in the
 * incoming config is replaced by the stored value at the same server, field and
 * key, so a read-modify-write never overwrites a secret with the mask.
 *
 * A masked part of an arg is restored by position the same way: an incoming arg
 * equal to the masked form of the stored arg at the same index gets the stored
 * arg back.
 *
 * A stored value is only restored into a server whose type, command, args (with
 * secret parts treated as equal) and url are unchanged. Otherwise a caller who
 * can only see masks could re-point a server at a host they control and have
 * the stored secret sent there.
 *
 * Masks with nothing to restore are returned in `unresolved` as
 * "server.field.key" or "server.args.index" (never values) so the caller can reject the write.
 */
export function restoreMaskedToolValues(
	incoming: JsonRecord,
	stored: unknown,
): { tools: JsonRecord; unresolved: string[] } {
	const unresolved: string[] = []
	if (!isRecord(incoming.mcpServers)) return { tools: incoming, unresolved }

	const storedServers = Object.fromEntries(serversOf(stored))
	const mcpServers: JsonRecord = {}
	for (const [name, server] of Object.entries(incoming.mcpServers)) {
		if (!isRecord(server)) {
			mcpServers[name] = server
			continue
		}
		const storedServer = storedServers[name]
		const restored: JsonRecord = { ...server }
		for (const field of SECRET_FIELDS) {
			const values = server[field]
			if (!isRecord(values)) continue
			const storedValues = storedServer && isRecord(storedServer[field]) ? storedServer[field] : {}
			const next: JsonRecord = {}
			for (const [key, value] of Object.entries(values)) {
				if (value !== MASKED_VALUE) {
					next[key] = value
				} else if (
					storedServer &&
					sameTransport(server, storedServer) &&
					typeof storedValues[key] === 'string'
				) {
					next[key] = storedValues[key]
				} else {
					unresolved.push(`${name}.${field}.${key}`)
				}
			}
			restored[field] = next
		}
		if (Array.isArray(server.args)) {
			const storedArgs =
				storedServer && sameTransport(server, storedServer) && Array.isArray(storedServer.args)
					? storedServer.args
					: []
			const maskedStored = maskArgs(storedArgs)
			restored.args = server.args.map((arg, index) => {
				if (typeof arg !== 'string' || !arg.includes(MASKED_VALUE)) return arg
				if (arg === maskedStored[index] && typeof storedArgs[index] === 'string') {
					return storedArgs[index]
				}
				if (arg !== storedArgs[index]) unresolved.push(`${name}.args.${index}`)
				return arg
			})
		}
		mcpServers[name] = restored
	}
	return { tools: { ...incoming, mcpServers }, unresolved }
}
