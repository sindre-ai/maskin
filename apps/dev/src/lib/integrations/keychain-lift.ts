import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database, Transaction } from '@maskin/db'
import { events, actors, agentGrants, integrations, workspaceMembers } from '@maskin/db/schema'
import { byoApiKeyEnvName } from '@maskin/shared'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { maskArgs } from '../actor-tools-redaction'
import { decrypt, decryptStoredCredential, encrypt, encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertKeychainGrants } from './agent-grants'
import { BYO_APIKEY_PROVIDER } from './byo-apikey'
import { insertCredentialAccessLog } from './credential-audit'
import {
	CredentialNameError,
	assertSlugFree,
	assertValidCredentialName,
	lockCredentialSlug,
} from './credential-name'
import { checkCredentialValue } from './credential-value'
import {
	CUSTOM_MCP_PROVIDER,
	type CustomMcpServer,
	customMcpServerSchema,
	readCustomServer,
} from './custom-mcp'

/** Source on the audit row a lift writes. */
export const LIFT_SOURCE = 'lift'
export const LIFT_EVENT_ACTION = 'keychain_lifted'
export const LIFT_UNDO_EVENT_ACTION = 'keychain_lift_undone'

/**
 * The name map: which provider a tool server belongs to, and the display name its key
 * gets. The display name is the env var name the reference uses, so Cloudflare becomes
 * KEYCHAIN_BYO_APIKEY_CLOUDFLARE. A server is matched on its own name first, then on
 * its URL and command. Never on a value.
 */
const PROVIDERS = [
	{ id: 'cloudflare', displayName: 'Cloudflare', pattern: /cloudflare/i },
	{ id: 'coolify', displayName: 'Coolify', pattern: /coolify/i },
	{ id: 'sentry', displayName: 'Sentry', pattern: /sentry/i },
	{ id: 'supabase', displayName: 'Supabase', pattern: /supabase/i },
] as const

/** An env var or header whose name says it holds a secret. */
const SECRET_NAME = /(token|secret|api[-_]?key|password|authorization)/i
/** A short word in front of a header token, kept as it is: "Bearer ". */
const SCHEME_PREFIX = /^([A-Za-z]{1,16} )?(.+)$/s
const URL_SECRET = /[?&](token|key|api[-_]?key|secret|access[-_]?token)=[^&$]/i

export type CannotLiftReason = 'in_args' | 'in_url' | 'open_to_workspace' | `value_rule:${string}`

export type LiftLocation = 'env' | 'headers'

export interface LiftEntryReport {
	integrationId: string
	serverName: string
	location: LiftLocation | 'args' | 'url'
	field: string
	provider: string
	keyName: string | null
	/** Agents that hold access to the tool server, and so would be granted the key. */
	actorIds: string[]
	status: 'would_lift' | 'cannot_lift'
	reason?: CannotLiftReason
}

export interface AgentConfigFinding {
	actorId: string
	serverName: string
	location: LiftLocation
	field: string
}

/** What a dry run returns. Names, ids and reasons only: no value, no prefix of one. */
export interface LiftReport {
	keys: { keyName: string; entries: number; actorIds: string[] }[]
	entries: LiftEntryReport[]
	/** Literal secrets found in agents' own tool config. Reported, never moved. */
	agentConfigFindings: AgentConfigFinding[]
}

interface Candidate {
	integrationId: string
	serverName: string
	location: LiftLocation
	field: string
	/** Text in front of the token that stays, e.g. "Bearer ". */
	prefix: string
	/** The token. Stays inside this module's plan and is never put on a report. */
	value: string
	provider: (typeof PROVIDERS)[number]
	actorIds: string[]
}

interface Group {
	keyName: string
	value: string
	candidates: Candidate[]
	actorIds: string[]
}

export interface LiftPlan {
	report: LiftReport
	groups: Group[]
}

function providerOf(name: string, server: CustomMcpServer) {
	const byName = PROVIDERS.find((p) => p.pattern.test(name))
	if (byName) return byName
	const where = [server.url ?? '', server.command ?? '', ...Object.keys(server.env ?? {})].join(' ')
	return PROVIDERS.find((p) => p.pattern.test(where)) ?? null
}

function splitSecret(raw: string): { prefix: string; value: string } | null {
	// A reference or any other placeholder is not a literal secret.
	if (raw.includes('${') || raw.trim() === '') return null
	const m = raw.match(SCHEME_PREFIX)
	if (!m) return null
	return { prefix: m[1] ?? '', value: m[2] as string }
}

function literalFields(
	record: Record<string, string> | undefined,
): { field: string; prefix: string; value: string }[] {
	const out: { field: string; prefix: string; value: string }[] = []
	for (const [field, raw] of Object.entries(record ?? {})) {
		if (!SECRET_NAME.test(field)) continue
		const parts = splitSecret(raw)
		if (parts) out.push({ field, ...parts })
	}
	return out
}

/**
 * Reads the workspace's tool servers and works out what a lift would do. Writes nothing.
 * The dry run is the report of this plan; apply runs the same plan.
 */
export async function planLift(db: Database, workspaceId: string): Promise<LiftPlan> {
	const rows = await db
		.select({
			id: integrations.id,
			displayName: integrations.displayName,
			credentials: integrations.credentials,
			defaultAgentAccess: integrations.defaultAgentAccess,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.orderBy(integrations.createdAt, integrations.id)
	const grantRows = rows.length
		? await db
				.select({ integrationId: agentGrants.integrationId, actorId: agentGrants.actorId })
				.from(agentGrants)
				.where(
					and(
						inArray(
							agentGrants.integrationId,
							rows.map((r) => r.id),
						),
						inArray(agentGrants.access, ['read', 'read_write']),
					),
				)
		: []
	const actorsOf = (integrationId: string) =>
		grantRows
			.filter((g) => g.integrationId === integrationId)
			.map((g) => g.actorId)
			.sort()

	const entries: LiftEntryReport[] = []
	const candidates: Candidate[] = []
	for (const row of rows) {
		const server = readCustomServer(row)
		if (!server) continue
		const serverName = row.displayName ?? 'server'
		const provider = providerOf(serverName, server)
		if (!provider) continue
		const actorIds = actorsOf(row.id)
		const base = { integrationId: row.id, serverName, provider: provider.id, actorIds }

		const blocked = (
			location: LiftEntryReport['location'],
			field: string,
			reason: CannotLiftReason,
		) =>
			entries.push({
				...base,
				location,
				field,
				keyName: null,
				status: 'cannot_lift',
				reason,
			})

		// A reference only works in an env or header value, so a token anywhere else stays put.
		const args = server.args ?? []
		if (maskArgs(args).some((masked, i) => masked !== args[i])) blocked('args', 'args', 'in_args')
		if (server.url && URL_SECRET.test(server.url)) blocked('url', 'url', 'in_url')

		for (const location of ['env', 'headers'] as const) {
			for (const lit of literalFields(server[location])) {
				const problem = checkCredentialValue(lit.value)
				if (problem) {
					blocked(location, lit.field, `value_rule:${problem}`)
				} else if (row.defaultAgentAccess !== 'none') {
					// The key has no default access, so a lift would take the tool away from
					// every agent that reaches it by the workspace default.
					blocked(location, lit.field, 'open_to_workspace')
				} else {
					candidates.push({
						integrationId: row.id,
						serverName,
						location,
						field: lit.field,
						prefix: lit.prefix,
						value: lit.value,
						provider,
						actorIds,
					})
				}
			}
		}
	}

	// Identical values become one key, so Cloudflare on four tool servers is one key. The
	// same name with a different value is a second group; it meets the name check on apply.
	const groups: Group[] = []
	for (const c of candidates) {
		const keyName = c.provider.displayName
		let group = groups.find((g) => g.keyName === keyName && g.value === c.value)
		if (!group) {
			group = { keyName, value: c.value, candidates: [], actorIds: [] }
			groups.push(group)
		}
		group.candidates.push(c)
		group.actorIds = [...new Set([...group.actorIds, ...c.actorIds])].sort()
	}
	for (const g of groups) {
		for (const c of g.candidates) {
			entries.push({
				integrationId: c.integrationId,
				serverName: c.serverName,
				location: c.location,
				field: c.field,
				provider: c.provider.id,
				keyName: g.keyName,
				actorIds: c.actorIds,
				status: 'would_lift',
			})
		}
	}

	return {
		groups,
		report: {
			keys: groups.map((g) => ({
				keyName: g.keyName,
				entries: g.candidates.length,
				actorIds: g.actorIds,
			})),
			entries,
			agentConfigFindings: await findAgentConfigLiterals(db, workspaceId),
		},
	}
}

/** Literal secrets sitting in agents' own tool config. Report only: a lift does not touch them. */
async function findAgentConfigLiterals(
	db: Database,
	workspaceId: string,
): Promise<AgentConfigFinding[]> {
	const agents = await db
		.select({ id: actors.id, tools: actors.tools })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))
	const findings: AgentConfigFinding[] = []
	for (const agent of agents) {
		const servers = (agent.tools as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
		for (const [serverName, spec] of Object.entries(servers ?? {})) {
			if (typeof spec !== 'object' || spec === null) continue
			for (const location of ['env', 'headers'] as const) {
				const record = (spec as Record<string, unknown>)[location]
				if (typeof record !== 'object' || record === null) continue
				for (const lit of literalFields(record as Record<string, string>)) {
					findings.push({ actorId: agent.id, serverName, location, field: lit.field })
				}
			}
		}
	}
	return findings
}

export type LiftKeyResult =
	| { keyName: string; status: 'lifted'; integrationId: string; eventId: string; entries: number }
	| { keyName: string; status: 'aborted'; reason: 'name_taken' | 'name_invalid' | 'changed' }

class GroupAborted extends Error {
	constructor(readonly reason: 'name_taken' | 'name_invalid' | 'changed') {
		super(reason)
		this.name = 'GroupAborted'
	}
}

function reference(keyName: string): string {
	// Names in the map always make a usable env var name.
	return `\${${byoApiKeyEnvName(keyName) as string}}`
}

function rewriteField(
	stored: { server?: unknown },
	location: LiftLocation,
	field: string,
	expect: string,
	to: string,
): { server: CustomMcpServer } | null {
	const parsed = customMcpServerSchema.safeParse(stored.server)
	if (!parsed.success) return null
	const server = parsed.data
	const record = server[location]
	if (!record || record[field] !== expect) return null
	return { server: { ...server, [location]: { ...record, [field]: to } } }
}

async function lockedServerRow(tx: Transaction, workspaceId: string, integrationId: string) {
	const [row] = await tx
		.select({ credentials: integrations.credentials, status: integrations.status })
		.from(integrations)
		.where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, workspaceId)))
		.for('update')
		.limit(1)
	if (!row || row.status !== 'active' || !row.credentials) return null
	try {
		const stored = JSON.parse(decrypt(row.credentials)) as { server?: unknown }
		return stored
	} catch {
		return null
	}
}

/**
 * Moves every token the plan found into a saved key and puts a reference where it was.
 * One transaction per key: the key, its grants, every rewritten tool server, the audit row
 * and the event commit together or not at all. A name that is already taken aborts that
 * key only. Running it again finds only references, so it does nothing.
 */
export async function applyLift(
	db: Database,
	kms: KmsProvider,
	params: { workspaceId: string; actorId: string },
): Promise<LiftKeyResult[]> {
	const { workspaceId, actorId } = params
	const plan = await planLift(db, workspaceId)
	const results: LiftKeyResult[] = []

	for (const group of plan.groups) {
		try {
			assertValidCredentialName(group.keyName)
			await assertSlugFree(db, workspaceId, group.keyName)
		} catch (err) {
			if (err instanceof CredentialNameError) {
				results.push({
					keyName: group.keyName,
					status: 'aborted',
					reason: err.code === 'NAME_TAKEN' ? 'name_taken' : 'name_invalid',
				})
				continue
			}
			throw err
		}

		const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, group.value)
		const integrationId = randomUUID()
		const ref = reference(group.keyName)
		try {
			const eventId = await db.transaction(async (tx) => {
				await lockCredentialSlug(tx, workspaceId, group.keyName)
				try {
					await assertSlugFree(tx, workspaceId, group.keyName)
				} catch (err) {
					if (err instanceof CredentialNameError) throw new GroupAborted('name_taken')
					throw err
				}
				await tx.insert(integrations).values({
					id: integrationId,
					workspaceId,
					provider: BYO_APIKEY_PROVIDER,
					status: 'active',
					credentials,
					dekCiphertext,
					providerMode: 'byo_apikey',
					displayName: group.keyName,
					defaultAgentAccess: 'none',
					source: 'admin_ui',
					createdBy: actorId,
				})
				// The agents that hold the tool server, and nobody else: never a workspace grant.
				await insertKeychainGrants(tx, {
					workspaceId,
					integrationId,
					actorIds: group.actorIds,
					createdBy: actorId,
				})
				for (const c of group.candidates) {
					const stored = await lockedServerRow(tx, workspaceId, c.integrationId)
					const next = stored
						? rewriteField(stored, c.location, c.field, c.prefix + c.value, c.prefix + ref)
						: null
					// Edited since the plan was read: leave this key for a fresh dry run.
					if (!stored || !next) throw new GroupAborted('changed')
					await tx
						.update(integrations)
						.set({
							credentials: encrypt(JSON.stringify({ ...stored, ...next })),
							updatedAt: new Date(),
						})
						.where(eq(integrations.id, c.integrationId))
				}
				await insertCredentialAccessLog(tx, {
					workspaceId,
					integrationId,
					actorId,
					action: 'create',
					source: LIFT_SOURCE,
					requestId: `lift:${integrationId}`,
				})
				await recordEvent(tx, {
					workspaceId,
					actorId,
					action: LIFT_EVENT_ACTION,
					entityType: 'integration',
					entityId: integrationId,
					// Names, ids and the kept prefix only. Never a value.
					data: {
						key_name: group.keyName,
						actor_ids: group.actorIds,
						entries: group.candidates.map((c) => ({
							integration_id: c.integrationId,
							server_name: c.serverName,
							location: c.location,
							field: c.field,
							prefix: c.prefix,
						})),
					},
				})
				const [event] = await tx
					.select({ id: events.id })
					.from(events)
					.where(
						and(
							eq(events.workspaceId, workspaceId),
							eq(events.entityId, integrationId),
							eq(events.action, LIFT_EVENT_ACTION),
						),
					)
					.orderBy(desc(events.id))
					.limit(1)
				return String(event?.id)
			})
			results.push({
				keyName: group.keyName,
				status: 'lifted',
				integrationId,
				eventId,
				entries: group.candidates.length,
			})
		} catch (err) {
			if (err instanceof GroupAborted) {
				results.push({ keyName: group.keyName, status: 'aborted', reason: err.reason })
				continue
			}
			throw err
		}
	}
	return results
}

export type UndoLiftOutcome =
	| { kind: 'undone'; restored: number; skipped: number }
	| { kind: 'not_found' }
	| { kind: 'already_undone' }
	| { kind: 'key_gone' }

interface LiftEventData {
	key_name: string
	entries: {
		integration_id: string
		server_name: string
		location: LiftLocation
		field: string
		prefix: string
	}[]
}

/**
 * Puts the tokens back where one lift event took them from. The old value is read from
 * the saved key (a read, so it is audited), never from the event, which holds names only:
 * if the key was replaced since, the replaced value goes back. A tool server edited since
 * the lift is left as it is. The key is then removed the way a removal does it.
 */
export async function undoLift(
	db: Database,
	kms: KmsProvider,
	params: { workspaceId: string; actorId: string; eventId: string },
): Promise<UndoLiftOutcome> {
	const { workspaceId, actorId } = params
	if (!/^\d+$/.test(params.eventId)) return { kind: 'not_found' }
	const [event] = await db
		.select({ entityId: events.entityId, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, Number(params.eventId)),
				eq(events.workspaceId, workspaceId),
				eq(events.action, LIFT_EVENT_ACTION),
			),
		)
		.limit(1)
	if (!event) return { kind: 'not_found' }
	const data = event.data as LiftEventData
	const keyId = event.entityId

	const [key] = await db
		.select({
			status: integrations.status,
			credentials: integrations.credentials,
			dekCiphertext: integrations.dekCiphertext,
		})
		.from(integrations)
		.where(and(eq(integrations.id, keyId), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!key || key.status === 'undone') {
		return key ? { kind: 'already_undone' } : { kind: 'not_found' }
	}
	if (key.status !== 'active' || !key.credentials) return { kind: 'key_gone' }
	const value = await decryptStoredCredential(kms, {
		workspaceId,
		credentials: key.credentials,
		dekCiphertext: key.dekCiphertext,
	})
	const ref = reference(data.key_name)

	return db.transaction(async (tx) => {
		let restored = 0
		let skipped = 0
		for (const e of data.entries) {
			const stored = await lockedServerRow(tx, workspaceId, e.integration_id)
			const next = stored
				? rewriteField(stored, e.location, e.field, e.prefix + ref, e.prefix + value)
				: null
			if (!stored || !next) {
				skipped++
				continue
			}
			await tx
				.update(integrations)
				.set({
					credentials: encrypt(JSON.stringify({ ...stored, ...next })),
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, e.integration_id))
			restored++
		}
		await tx
			.update(integrations)
			.set({
				status: 'undone',
				credentials: null,
				dekCiphertext: null,
				undoExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, keyId))
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: keyId,
			actorId,
			action: 'read',
			source: LIFT_SOURCE,
			requestId: `lift-undo-read:${keyId}`,
		})
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: keyId,
			actorId,
			action: 'undone',
			source: LIFT_SOURCE,
			requestId: `lift-undo:${keyId}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: LIFT_UNDO_EVENT_ACTION,
			entityType: 'integration',
			entityId: keyId,
			data: { key_name: data.key_name, undoes_event_id: params.eventId, restored, skipped },
		})
		return { kind: 'undone' as const, restored, skipped }
	})
}
