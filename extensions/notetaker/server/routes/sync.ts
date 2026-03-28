import type { Database } from '@ai-native/db'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { GetTokenFn } from '../services/scheduler.js'
import { syncAllWorkspaces } from '../services/scheduler.js'

type HonoEnv = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

/**
 * POST /api/m/notetaker/sync
 *
 * Triggers calendar sync across all workspaces with active calendar integrations.
 * Designed to be called by a Maskin cron trigger on a schedule (e.g. every 5 minutes).
 *
 * The getToken function is injected so this route can use the platform's
 * TokenManager for credential decryption and token refresh.
 */
export function createSyncRoutes(env: ModuleEnv, getToken: GetTokenFn) {
	const app = new OpenAPIHono<HonoEnv>()

	app.post('/sync', async (c) => {
		// Run sync asynchronously — respond immediately
		syncAllWorkspaces(getToken, env).catch((err) => {
			console.error('Calendar sync failed', {
				error: err instanceof Error ? err.message : err,
			})
		})

		return c.json({ ok: true, status: 'sync_started' })
	})

	return app
}
