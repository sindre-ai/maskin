import { sessions } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { db } from './global-setup'

/**
 * The two SessionManager methods the relaunch path uses, against the real test
 * database. stopSession settles the row the way the remote path's provisional write
 * does, so the row is terminal when the call returns. Override stopSession to model
 * a stop that fails, or one that never settles.
 */
export function fakeSessionControl(
	overrides: { stopSession?: (sessionId: string) => Promise<void> } = {},
) {
	const stopSession = vi.fn(
		overrides.stopSession ??
			(async (sessionId: string) => {
				await db.update(sessions).set({ status: 'user_stopped' }).where(eq(sessions.id, sessionId))
			}),
	)
	const control = {
		stopSession,
		findConversationSessionAnyActive: async (conversationId: string, actorId: string) => {
			const [row] = await db
				.select()
				.from(sessions)
				.where(
					and(
						eq(sessions.conversationId, conversationId),
						eq(sessions.actorId, actorId),
						eq(sessions.interactive, true),
						inArray(sessions.status, ['pending', 'starting', 'queued', 'running']),
					),
				)
				.limit(1)
			return row ?? null
		},
	}
	return control as typeof control & Pick<SessionManager, 'stopSession'>
}
