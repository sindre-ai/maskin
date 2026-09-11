import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { enumerateLinkedInIdentitiesAndRegister } from '../lib/integrations/providers/linkedin-unipile/enumeration'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * R11-A · Admin refresh-identities endpoint.
 *
 * `POST /api/admin/linkedin-unipile/refresh-identities` re-runs identity
 * enumeration for every `linkedin-unipile` credential in the calling actor's
 * workspace. Two live cases need this:
 *
 *   1. A page-admin grant changes and the customer wants the new instance
 *      registered without reconnecting the credential — a full reconnect
 *      works too but re-runs the wizard.
 *   2. A Phase 1 credential landed BEFORE R11 and therefore has no
 *      `unipile_acc_slug` yet. One refresh call populates the slug and
 *      registers the fan-out instances so `tools/list` returns them the
 *      next time the actor's session hits the LinkedIn MCP route.
 *
 * Deliberately NOT surfaced as an MCP tool (spec §10 R11 item 3) — agents
 * should never trigger enumeration in the middle of a run; that is a human
 * or ops action. Body-less POST; the response is `{ refreshed, errors }`
 * (one entry per credential processed).
 *
 * Auth: goes through `authMiddleware` in `app-factory.ts`, and the handler
 * re-checks `isWorkspaceMember` because the route is header-scoped (see
 * repo CLAUDE.md — the isWorkspaceMember check is required for
 * X-Workspace-Id routes only when the workspace is not derived from a
 * URL-path resource, which is the case here).
 */

const PROVIDER = 'linkedin-unipile'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

app.post('/refresh-identities', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const rows = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, PROVIDER)))

	const refreshed: Array<{
		integration_id: string
		unipile_acc_slug: string
		instances: string[]
	}> = []
	const errors: Array<{ integration_id: string; error: string }> = []

	for (const row of rows) {
		// Skip rows still stuck in `pending` — their credential hasn't landed, so
		// enumeration would just 401 in a loop. `active` is the shared vocabulary
		// (see CONNECTED_STATUS in the connect-callback route).
		if (row.status !== 'active' || !row.externalId) continue
		try {
			const result = await enumerateLinkedInIdentitiesAndRegister({
				unipileAccountId: row.externalId,
				workspaceId,
				actorId: row.actorId ?? row.createdBy,
				integrationId: row.id,
			})
			if (row.unipileAccSlug !== result.unipileAccSlug) {
				await db
					.update(integrations)
					.set({ unipileAccSlug: result.unipileAccSlug, updatedAt: new Date() })
					.where(eq(integrations.id, row.id))
				await db.insert(events).values({
					workspaceId,
					actorId: row.actorId ?? row.createdBy,
					action: 'updated',
					entityType: 'integration',
					entityId: row.id,
					data: {
						provider: PROVIDER,
						reason: 'refresh_identities',
						unipile_acc_slug: result.unipileAccSlug,
					},
				})
			}
			refreshed.push({
				integration_id: row.id,
				unipile_acc_slug: result.unipileAccSlug,
				instances: result.instances.map((cfg) => `${cfg.unipileAccSlug}-${cfg.identitySlug}`),
			})
		} catch (err) {
			logger.error('linkedin-unipile refresh-identities: enumeration failed', {
				workspaceId,
				integrationId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
			errors.push({
				integration_id: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return c.json({ refreshed, errors })
})

export default app
