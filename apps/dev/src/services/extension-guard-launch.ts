import type { Database } from '@maskin/db'
import { extensions, sessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { buildGuardPolicy, guardServer, mintGuardKey } from '../lib/integrations/mcp-guard'
import { logger } from '../lib/logger'

/** Launch key of a custom-extension MCP server: extension-{slug}. Built-ins never use it. */
export const EXTENSION_SERVER_PREFIX = 'extension-'

export const GUARD_REPORT_PATH = '/api/internal/mcp-guard/report'

/**
 * Put the guard wrapper in front of every custom-extension MCP server in the
 * launch set, in place. Built-in integrations are not touched. A custom server
 * that cannot be guarded (row gone, not stdio) is removed from the set: it is
 * never launched unguarded.
 *
 * Each guarded server gets its own session key. Only the hash is stored, under
 * sessions.config.guard_keys, so the report endpoint can check the key later.
 */
export async function applyExtensionGuards(opts: {
	db: Database
	sessionId: string
	workspaceId: string
	agentId: string
	apiUrl: string
	servers: Record<string, unknown>
}): Promise<void> {
	const { db, sessionId, workspaceId, agentId, servers } = opts
	const keys = Object.keys(servers).filter((k) => k.startsWith(EXTENSION_SERVER_PREFIX))
	if (keys.length === 0) return

	const slugs = keys.map((k) => k.slice(EXTENSION_SERVER_PREFIX.length))
	const rows = await db
		.select({ id: extensions.id, slug: extensions.slug, toolGrants: extensions.toolGrants })
		.from(extensions)
		.where(and(eq(extensions.workspaceId, workspaceId), inArray(extensions.slug, slugs)))
	const bySlug = new Map(rows.map((r) => [r.slug, r]))

	const reportUrl = `${opts.apiUrl.replace(/\/$/, '')}${GUARD_REPORT_PATH}`
	const hashes: Record<string, string> = {}
	for (const key of keys) {
		const ext = bySlug.get(key.slice(EXTENSION_SERVER_PREFIX.length))
		const minted = ext ? mintGuardKey(sessionId, ext.id) : null
		const guarded =
			ext && minted
				? guardServer(servers[key], buildGuardPolicy(ext.toolGrants, agentId), {
						reportUrl,
						sessionKey: minted.key,
					})
				: null
		if (!ext || !minted || !guarded) {
			delete servers[key]
			logger.warn('Dropped custom extension MCP server that cannot be guarded', {
				sessionId,
				server: key,
				reason: ext ? 'not_stdio' : 'extension_not_found',
			})
			continue
		}
		servers[key] = guarded
		hashes[ext.id] = minted.hash
	}
	if (Object.keys(hashes).length === 0) return

	await db
		.update(sessions)
		.set({
			config: sql`jsonb_set(${sessions.config}, '{guard_keys}', coalesce(${sessions.config}->'guard_keys', '{}'::jsonb) || ${JSON.stringify(hashes)}::jsonb)`,
		})
		.where(eq(sessions.id, sessionId))
}
