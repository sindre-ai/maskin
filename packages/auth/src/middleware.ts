import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import { createApiError } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { validateApiKey } from './api-keys'

export function authMiddleware(db: Database) {
	return createMiddleware(async (c, next) => {
		const authHeader = c.req.header('Authorization')
		if (!authHeader?.startsWith('Bearer ')) {
			return c.json(
				createApiError(
					'UNAUTHORIZED',
					'Missing or invalid Authorization header',
					undefined,
					"Provide a Bearer token in the Authorization header: 'Authorization: Bearer ank_...'",
				),
				401,
			)
		}

		const token = authHeader.slice(7)

		// API key auth
		if (token.startsWith('ank_')) {
			const result = await validateApiKey(db, token)
			if (!result) {
				return c.json(
					createApiError(
						'UNAUTHORIZED',
						'Invalid API key',
						undefined,
						'Check that your API key is correct and has not been regenerated',
					),
					401,
				)
			}
			c.set('actorId', result.actorId)
			c.set('actorType', result.type)

			// Verify workspace membership when X-Workspace-Id header is present.
			// By-ID routes also check membership via isWorkspaceMember() in workspace-auth.ts
			// since they derive the workspace from the resource, not the header.
			const workspaceId = c.req.header('X-Workspace-Id')
			if (workspaceId) {
				const [member] = await db
					.select({ actorId: workspaceMembers.actorId })
					.from(workspaceMembers)
					.where(
						and(
							eq(workspaceMembers.actorId, result.actorId),
							eq(workspaceMembers.workspaceId, workspaceId),
						),
					)
					.limit(1)
				if (!member) {
					return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
				}
			}

			return next()
		}

		// Future: Better Auth session validation
		return c.json(
			createApiError(
				'UNAUTHORIZED',
				'Invalid token format',
				undefined,
				"API keys must start with 'ank_'. Use POST /api/actors to create an actor and get an API key.",
			),
			401,
		)
	})
}
