import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	extensions,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { type McpConfig, mcpRemoteUrl } from '@maskin/shared'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../analytics/posthog'
import { decrypt, encrypt } from '../crypto'
import { logger } from '../logger'
import { MAX_EXTENSION_TOOLS, extensionMcpProvider, extensionProvider } from './extensions'
import { getIntegrationCredential } from './lookup'

const EXTENSION_SYSTEM_ACTOR_NAME = 'Custom extension'

/**
 * Events need an actor, and the generic webhook route has no human behind a
 * delivery. Same shape as the Skjald system actor: one shared system actor,
 * added to each workspace as a member with the 'system' role.
 */
export async function ensureExtensionSystemActor(
	db: Database | Transaction,
	workspaceId: string,
	createdBy: string | null,
): Promise<string> {
	let [systemActor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(and(eq(actors.type, 'system'), eq(actors.name, EXTENSION_SYSTEM_ACTOR_NAME)))
		.limit(1)
	if (!systemActor) {
		;[systemActor] = await db
			.insert(actors)
			.values({
				type: 'system',
				name: EXTENSION_SYSTEM_ACTOR_NAME,
				apiKey: generateApiKey().key,
				createdBy,
			})
			.returning({ id: actors.id })
	}
	if (!systemActor) throw new Error('Failed to create system actor for extensions')

	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, systemActor.id),
			),
		)
		.limit(1)
	if (!member) {
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: systemActor.id, role: 'system' })
	}
	return systemActor.id
}

function secretRowWhere(workspaceId: string, slug: string) {
	return and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, extensionProvider(slug)),
		isNull(integrations.actorId),
	)
}

/**
 * Store (or replace) an extension's signing secret, encrypted, in the same
 * table and path Skjald uses: provider 'extension:{slug}', actor_id null.
 * The unique index on (workspace, actor, provider) does not dedupe a NULL
 * actor, so this selects first rather than relying on ON CONFLICT.
 */
export async function upsertExtensionSecret(
	db: Database | Transaction,
	args: { workspaceId: string; slug: string; secret: string; createdBy: string },
): Promise<void> {
	const credentials = encrypt(args.secret)
	const [existing] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(secretRowWhere(args.workspaceId, args.slug))
		.limit(1)
	if (existing) {
		await db
			.update(integrations)
			.set({ credentials, status: INTEGRATION_STATUS_ACTIVE, updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))
		return
	}
	await db.insert(integrations).values({
		workspaceId: args.workspaceId,
		provider: extensionProvider(args.slug),
		status: INTEGRATION_STATUS_ACTIVE,
		credentials,
		config: {},
		actorId: null,
		createdBy: args.createdBy,
	})
}

export async function hasExtensionSecret(
	db: Database | Transaction,
	workspaceId: string,
	slug: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(secretRowWhere(workspaceId, slug))
		.limit(1)
	return !!row
}

/** Decrypted signing secret, or null when none is stored. Never return this from a read API. */
export async function readExtensionSecret(
	db: Database | Transaction,
	workspaceId: string,
	slug: string,
): Promise<string | null> {
	const [row] = await db
		.select({ credentials: integrations.credentials })
		.from(integrations)
		.where(secretRowWhere(workspaceId, slug))
		.limit(1)
	if (!row?.credentials) return null
	return decrypt(row.credentials)
}

// ── MCP API key row (provider extension-mcp:{slug}) ─────────────────────────
// Its own row, so saving the MCP key never overwrites the webhook signing
// secret and hasExtensionSecret stays true only for a real signing secret.
// The read goes through Keychain (see createExtensionMcpKeyReader below); there is
// deliberately no decrypting counterpart here.

function mcpKeyRowWhere(workspaceId: string, slug: string) {
	return and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, extensionMcpProvider(slug)),
		isNull(integrations.actorId),
	)
}

/** Store (or replace) an extension's MCP API key, encrypted, on its own integrations row. */
export async function upsertExtensionMcpKey(
	db: Database | Transaction,
	args: { workspaceId: string; slug: string; key: string; createdBy: string },
): Promise<void> {
	const credentials = encrypt(args.key)
	const [existing] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(mcpKeyRowWhere(args.workspaceId, args.slug))
		.limit(1)
	if (existing) {
		await db
			.update(integrations)
			.set({ credentials, status: INTEGRATION_STATUS_ACTIVE, updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))
		return
	}
	await db.insert(integrations).values({
		workspaceId: args.workspaceId,
		provider: extensionMcpProvider(args.slug),
		status: INTEGRATION_STATUS_ACTIVE,
		credentials,
		config: {},
		actorId: null,
		createdBy: args.createdBy,
	})
}

export async function hasExtensionMcpKey(
	db: Database | Transaction,
	workspaceId: string,
	slug: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(mcpKeyRowWhere(workspaceId, slug))
		.limit(1)
	return !!row
}

// ── MCP runtime shim ────────────────────────────────────────────────────────

export type ExtensionMcpEntry = {
	slug: string
	extensionId: string
	config: McpConfig
	/** The extension's MCP key row (provider extension-mcp:{slug}), when one exists. Never its credentials. */
	credentialIntegrationId: string | null
}

/**
 * Active extensions in a workspace that want their MCP server attached to
 * sessions: status active, an mcp_config, autoInject true. Ordered by slug so
 * the attach order is stable.
 */
export async function resolveMcpFromExtension(
	db: Database | Transaction,
	workspaceId: string,
): Promise<ExtensionMcpEntry[]> {
	const rows = await db
		.select({
			id: extensions.id,
			slug: extensions.slug,
			mcpConfig: extensions.mcpConfig,
			credentialIntegrationId: integrations.id,
		})
		.from(extensions)
		.leftJoin(
			integrations,
			and(
				eq(integrations.workspaceId, extensions.workspaceId),
				eq(integrations.provider, sql`'extension-mcp:' || ${extensions.slug}`),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
				isNull(integrations.actorId),
			),
		)
		.where(
			and(
				eq(extensions.workspaceId, workspaceId),
				eq(extensions.status, 'active'),
				isNotNull(extensions.mcpConfig),
				sql`(${extensions.mcpConfig}->>'autoInject')::boolean = true`,
			),
		)
		.orderBy(asc(extensions.slug))
	return rows.flatMap((r) =>
		r.mcpConfig
			? [
					{
						slug: r.slug,
						extensionId: r.id,
						config: r.mcpConfig,
						credentialIntegrationId: r.credentialIntegrationId,
					},
				]
			: [],
	)
}

export type ExtensionMcpKeyReader = (entry: ExtensionMcpEntry) => Promise<string | null>

/** The MCP server's host, for the audit row. Null for a shape with no URL we can parse. */
function mcpHost(server: McpConfig['server']): string | null {
	const url = mcpRemoteUrl(server)
	if (!url) return null
	try {
		return new URL(url).host
	} catch {
		return null
	}
}

/**
 * The Keychain-backed read of an extension's MCP key (row extension-mcp:{slug}),
 * for one session launch. Every read goes through getCredential: the agent's
 * access is checked, the value decrypted, and one audit row written (actor, session,
 * the MCP host as outbound target). A missing row, a denied read or any other
 * failure returns null, so the server is not attached; the reason is logged
 * without the value. Nothing here decrypts the row itself.
 */
export function createExtensionMcpKeyReader(
	db: Database,
	launch: { workspaceId: string; actorId: string; sessionId: string },
): ExtensionMcpKeyReader {
	return async (entry) => {
		const outboundTarget = mcpHost(entry.config.server)
		try {
			const credential = await getIntegrationCredential(
				db,
				launch.workspaceId,
				extensionMcpProvider(entry.slug),
				null,
				{
					ctx: {
						requestingActorId: launch.actorId,
						sessionId: launch.sessionId,
						requestId: randomUUID(),
						...(outboundTarget ? { outboundTarget } : {}),
					},
				},
			)
			return credential?.value || null
		} catch (err) {
			logger.warn('Extension MCP key not readable', {
				workspaceId: launch.workspaceId,
				sessionId: launch.sessionId,
				slug: entry.slug,
				error: err instanceof Error ? err.name : 'unknown',
			})
			return null
		}
	}
}

/**
 * Turn a workspace's extension MCPs into session entries, keyed extension-{slug}
 * so they never collide with integration-{provider}. An extension over the tool
 * cap is not attached: its mcp_last_error says so and a PostHog event fires.
 * Only stdio attaches in V1. readKey is the injected Keychain read for the
 * extension's key row; its value is passed as a Bearer value through the env
 * var the config names. If the key cannot be read the server does not attach
 * and mcp_last_error says so; a server that attaches clears a stale error.
 * With no reader nothing attaches.
 */
export async function buildExtensionMcpServers(
	db: Database | Transaction,
	workspaceId: string,
	readKey: ExtensionMcpKeyReader | null,
): Promise<{ servers: Record<string, unknown>; env: Record<string, string> }> {
	const servers: Record<string, unknown> = {}
	const env: Record<string, string> = {}
	if (!readKey) return { servers, env }
	for (const entry of await resolveMcpFromExtension(db, workspaceId)) {
		const { server, tools } = entry.config
		if (server.type !== 'stdio') continue
		if (tools.length > MAX_EXTENSION_TOOLS) {
			await db
				.update(extensions)
				.set({ mcpLastError: `tool cap exceeded: ${tools.length}/${MAX_EXTENSION_TOOLS}` })
				.where(eq(extensions.id, entry.extensionId))
			void capturePosthogEvent('extension_mcp_tool_cap_exceeded', workspaceId, {
				extension_id: entry.extensionId,
				slug: entry.slug,
				tool_count: tools.length,
			})
			continue
		}
		if (server.envFromCredential) {
			const key = await readKey(entry)
			if (!key) {
				await db
					.update(extensions)
					.set({ mcpLastError: 'key not readable' })
					.where(eq(extensions.id, entry.extensionId))
				continue
			}
			env[server.envFromCredential] = `Bearer ${key}`
		}
		servers[`extension-${entry.slug}`] = {
			type: 'stdio',
			command: server.command,
			args: server.args,
		}
		// It attaches now, so an earlier "key not readable" or tool-cap error is stale.
		await db
			.update(extensions)
			.set({ mcpLastError: null })
			.where(and(eq(extensions.id, entry.extensionId), isNotNull(extensions.mcpLastError)))
	}
	return { servers, env }
}
