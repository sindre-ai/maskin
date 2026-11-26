/**
 * No notification creates an email by itself. The per-notification sender is gone, so creating a
 * notification of any kind sends nothing, even for a person who had switched that kind's Email on
 * before it was removed (their saved choice stays in the database, unread). Mail is captured, never
 * sent.
 */
import { notificationPreferences, workspaceMembers } from '@maskin/db/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmail = vi.fn()

vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendEmail: (...args: unknown[]) => sendEmail(...args),
}))

import { buildCreateNotificationBody, insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

describe('creating a notification sends no email', () => {
	beforeEach(() => {
		sendEmail.mockReset()
		sendEmail.mockResolvedValue(true)
	})

	it('sends nothing for Needs you, Chat replies or Tips, even for a saved Email choice', async () => {
		const person = await insertActor(db, { type: 'human' })
		const personId = person.id as string
		const ws = await insertWorkspace(db, getTestActorId())
		// The route only accepts a target who is a member of the workspace.
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: personId, role: 'member' })
		await db.insert(notificationPreferences).values({
			actorId: personId,
			emailDigestEnabled: true,
			emailCategories: { needs_you: true, conversation: true, tips: true },
		})
		const app = createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
		const headers = { 'x-workspace-id': ws.id }

		const bodies = [
			{ type: 'needs_input' },
			{ type: 'good_news', metadata: { push_category: 'conversation' } },
			{ type: 'good_news', metadata: { push_category: 'tips' } },
		]
		for (const extra of bodies) {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({
						source_actor_id: getTestActorId(),
						target_actor_id: personId,
						...extra,
					}),
					headers,
				),
			)
			expect(res.status).toBe(201)
		}

		// Give any listener on the event stream a moment: none should exist.
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sendEmail).not.toHaveBeenCalled()
	})
})
