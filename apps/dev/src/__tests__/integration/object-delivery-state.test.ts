import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { recordEvent } from '../../lib/events/record-event'
import { DELIVERED_ACTION, withDeliveryState } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A delivered draft keeps reading as sent when its content hash moves afterwards. The hash
 * covers the detail lines read from metadata, and a LinkedIn post drops its "Scheduled"
 * line when it goes live, so the hash changes with no edit to the text.
 */

async function previewOf(objectId: string) {
	const [object] = await db.select().from(objects).where(eq(objects.id, objectId))
	const preview = buildObjectPreview(object as never)
	if (!preview) throw new Error('no preview')
	return preview
}

async function setup() {
	const actorId = getTestActorId()
	const workspace = await insertWorkspace(db, actorId)
	const post = await insertObject(db, workspace.id, actorId, {
		type: 'content',
		content: 'We are looking for businesses to help.',
		metadata: {
			content_type: 'linkedin_post',
			account: 'sebk_personal',
			scheduled_date: '2026-11-17',
		},
	})
	return { actorId, workspace, post }
}

describe('withDeliveryState', () => {
	it('shows a delivered post as sent after going live changes its hash', async () => {
		const { actorId, workspace, post } = await setup()
		const before = await previewOf(post.id)
		await recordEvent(db, {
			workspaceId: workspace.id,
			actorId,
			action: DELIVERED_ACTION,
			entityType: 'content',
			entityId: post.id,
			data: { content_hash: before.content_hash, provider: 'linkedin-unipile' },
		})

		// Going live clears the scheduled date. The text is untouched.
		await db
			.update(objects)
			.set({ metadata: { content_type: 'linkedin_post', account: 'sebk_personal' } })
			.where(eq(objects.id, post.id))
		const after = await previewOf(post.id)
		expect(after.content_hash).not.toBe(before.content_hash)

		const shown = await withDeliveryState(db, workspace.id, post.id, after)
		expect(shown.delivery?.state).toBe('sent')
		expect(shown.delivery?.at).not.toBeNull()
	})

	it('still shows a draft that was never delivered as a draft', async () => {
		const { workspace, post } = await setup()
		const shown = await withDeliveryState(db, workspace.id, post.id, await previewOf(post.id))
		expect(shown.delivery).toEqual({ state: 'draft', at: null })
	})
})
