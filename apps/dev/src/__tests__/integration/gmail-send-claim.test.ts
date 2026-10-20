import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	claimDraftForSend,
	settleDraftSend,
} from '../../lib/integrations/providers/gmail/send-claim'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The claim is what stops an approved email going out twice. It has to hold under real
 * concurrency, so it is tested on its own, against Postgres, with many callers at once:
 * the route's own pre-check usually answers first and would hide a broken claim.
 */

async function approvedDraft(metadata: Record<string, unknown> = {}) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	return insertObject(db, workspace.id, human, {
		type: 'task',
		metadata: { draft_state: 'approved', draft_original_body: 'x', ...metadata },
	})
}

const metaOf = async (id: string) =>
	((await db.select().from(objects).where(eq(objects.id, id)))[0]?.metadata ?? {}) as Record<
		string,
		unknown
	>

describe('claimDraftForSend', () => {
	it('gives the claim to exactly one of many simultaneous callers', async () => {
		const draft = await approvedDraft()

		const results = await Promise.all(
			Array.from({ length: 12 }, () => claimDraftForSend(db, draft.id)),
		)

		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await metaOf(draft.id)).toMatchObject({ draft_send_state: 'sending' })
	})

	it('refuses a draft whose approval was taken back', async () => {
		const draft = await approvedDraft({ draft_state: 'draft' })

		expect(await claimDraftForSend(db, draft.id)).toBe(false)
		expect(await metaOf(draft.id)).not.toHaveProperty('draft_send_state')
	})

	it('refuses a draft that was already sent, or is locked as unknown', async () => {
		const sent = await approvedDraft({ draft_send_state: 'sent' })
		const unknown = await approvedDraft({ draft_send_state: 'unknown' })

		expect(await claimDraftForSend(db, sent.id)).toBe(false)
		expect(await claimDraftForSend(db, unknown.id)).toBe(false)
	})

	it("keeps the card's own draft keys when it claims", async () => {
		const draft = await approvedDraft({ draft_subject: 'Hello' })

		await claimDraftForSend(db, draft.id)

		expect(await metaOf(draft.id)).toMatchObject({
			draft_state: 'approved',
			draft_subject: 'Hello',
			draft_send_state: 'sending',
		})
	})
})

describe('settleDraftSend', () => {
	it('records a send, and lets a released draft be claimed again', async () => {
		const draft = await approvedDraft()
		await claimDraftForSend(db, draft.id)

		await settleDraftSend(db, draft.id, { state: 'released' })
		expect(await metaOf(draft.id)).not.toHaveProperty('draft_send_state')
		expect(await claimDraftForSend(db, draft.id)).toBe(true)

		await settleDraftSend(db, draft.id, {
			state: 'sent',
			sentAt: '2026-10-20T10:00:00.000Z',
			messageId: 'sent-1',
		})
		expect(await metaOf(draft.id)).toMatchObject({
			draft_send_state: 'sent',
			draft_sent_message_id: 'sent-1',
			draft_sent_at: '2026-10-20T10:00:00.000Z',
		})
	})

	it('locks an unknown outcome against a second claim', async () => {
		const draft = await approvedDraft()
		await claimDraftForSend(db, draft.id)

		await settleDraftSend(db, draft.id, { state: 'unknown' })

		expect(await claimDraftForSend(db, draft.id)).toBe(false)
	})
})
