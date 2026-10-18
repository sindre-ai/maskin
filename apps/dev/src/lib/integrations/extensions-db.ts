import { generateApiKey } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	extensions,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import type { McpConfig } from '@maskin/shared'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../analytics/posthog'
import { decrypt, encrypt } from '../crypto'
import { MAX_EXTENSION_TOOLS, extensionProvider } from './extensions'

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

// ── MCP runtime shim ────────────────────────────────────────────────────────

export type ExtensionMcpEntry = {
	slug: string
	extensionId: string
	config: McpConfig
	/** The extension's integrations row, when one exists. Never its credentials. */
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
				eq(integrations.provider, sql`'extension:' || ${extensions.slug}`),
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

/**
 * Turn a workspace's extension MCPs into session entries, keyed extension-{slug}
 * so they never collide with integration-{provider}. An extension over the tool
 * cap is not attached: its mcp_last_error says so and a PostHog event fires.
 * Only stdio attaches in V1. readCredential returns the plain key for an
 * extension's integrations row; it is passed as a Bearer value through the
 * env var the config names.
 */
export async function buildExtensionMcpServers(
	db: Database | Transaction,
	workspaceId: string,
	readCredential: (entry: ExtensionMcpEntry) => Promise<string | null>,
): Promise<{ servers: Record<string, unknown>; env: Record<string, string> }> {
	const servers: Record<string, unknown> = {}
	const env: Record<string, string> = {}
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
			const key = await readCredential(entry)
			if (key) env[server.envFromCredential] = `Bearer ${key}`
		}
		servers[`extension-${entry.slug}`] = {
			type: 'stdio',
			command: server.command,
			args: server.args,
		}
	}
	return { servers, env }
}
